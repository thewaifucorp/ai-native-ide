//! Line-level diff with per-hunk selection for comprehensible checkpoints.
//!
//! The IDE lets a person inspect a change hunk by hunk and accept only some of
//! them without needing to understand Git. This crate computes a deterministic
//! line diff (LCS) between the original and proposed content, groups the changes
//! into hunks, and merges back only the selected hunks — an unselected hunk
//! stays at its original content.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineTag {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub tag: LineTag,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub id: usize,
    pub old_start: usize,
    pub new_start: usize,
    pub lines: Vec<DiffLine>,
}

enum Op {
    Equal(String),
    Removed(String),
    Added(String),
}

fn edit_script(original: &[&str], proposed: &[&str]) -> Vec<Op> {
    let rows = original.len();
    let cols = proposed.len();
    // dp[i][j] = LCS length of original[i..] and proposed[j..].
    let mut dp = vec![vec![0usize; cols + 1]; rows + 1];
    for i in (0..rows).rev() {
        for j in (0..cols).rev() {
            dp[i][j] = if original[i] == proposed[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut ops = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < rows && j < cols {
        if original[i] == proposed[j] {
            ops.push(Op::Equal(original[i].to_owned()));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(Op::Removed(original[i].to_owned()));
            i += 1;
        } else {
            ops.push(Op::Added(proposed[j].to_owned()));
            j += 1;
        }
    }
    while i < rows {
        ops.push(Op::Removed(original[i].to_owned()));
        i += 1;
    }
    while j < cols {
        ops.push(Op::Added(proposed[j].to_owned()));
        j += 1;
    }
    ops
}

/// Computes the hunks between original and proposed content. Consecutive
/// added/removed lines form one hunk; equal lines separate hunks.
pub fn diff(original: &str, proposed: &str) -> Vec<Hunk> {
    let original_lines: Vec<&str> = original.lines().collect();
    let proposed_lines: Vec<&str> = proposed.lines().collect();
    let ops = edit_script(&original_lines, &proposed_lines);

    let mut hunks = Vec::new();
    let mut current: Vec<DiffLine> = Vec::new();
    let mut old_index = 0usize;
    let mut new_index = 0usize;
    let mut hunk_old_start = 0usize;
    let mut hunk_new_start = 0usize;
    for op in ops {
        match op {
            Op::Equal(_) => {
                if !current.is_empty() {
                    hunks.push(Hunk {
                        id: hunks.len(),
                        old_start: hunk_old_start,
                        new_start: hunk_new_start,
                        lines: std::mem::take(&mut current),
                    });
                }
                old_index += 1;
                new_index += 1;
            }
            Op::Removed(text) => {
                if current.is_empty() {
                    hunk_old_start = old_index;
                    hunk_new_start = new_index;
                }
                current.push(DiffLine {
                    tag: LineTag::Removed,
                    text,
                });
                old_index += 1;
            }
            Op::Added(text) => {
                if current.is_empty() {
                    hunk_old_start = old_index;
                    hunk_new_start = new_index;
                }
                current.push(DiffLine {
                    tag: LineTag::Added,
                    text,
                });
                new_index += 1;
            }
        }
    }
    if !current.is_empty() {
        hunks.push(Hunk {
            id: hunks.len(),
            old_start: hunk_old_start,
            new_start: hunk_new_start,
            lines: current,
        });
    }
    hunks
}

/// Rebuilds the file content applying only the selected hunks. A selected hunk
/// contributes its added lines (removed lines dropped); an unselected hunk keeps
/// its original (removed) lines, so partial acceptance is always well-defined.
pub fn merge_selected(original: &str, proposed: &str, selected: &[usize]) -> String {
    let original_lines: Vec<&str> = original.lines().collect();
    let proposed_lines: Vec<&str> = proposed.lines().collect();
    let ops = edit_script(&original_lines, &proposed_lines);

    let mut output: Vec<String> = Vec::new();
    let mut hunk_id = 0usize;
    let mut in_hunk = false;
    let mut hunk_selected = false;
    for op in &ops {
        match op {
            Op::Equal(text) => {
                in_hunk = false;
                output.push(text.clone());
            }
            Op::Removed(text) => {
                if !in_hunk {
                    hunk_selected = selected.contains(&hunk_id);
                    hunk_id += 1;
                    in_hunk = true;
                }
                if !hunk_selected {
                    output.push(text.clone());
                }
            }
            Op::Added(text) => {
                if !in_hunk {
                    hunk_selected = selected.contains(&hunk_id);
                    hunk_id += 1;
                    in_hunk = true;
                }
                if hunk_selected {
                    output.push(text.clone());
                }
            }
        }
    }

    let mut merged = output.join("\n");
    // Preserve a trailing newline when both inputs used one, so a partial accept
    // does not silently rewrite the file's final line ending.
    if proposed.ends_with('\n') && !merged.is_empty() {
        merged.push('\n');
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_detects_added_and_removed_lines() {
        let hunks = diff("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(hunks.len(), 1);
        let tags: Vec<LineTag> = hunks[0].lines.iter().map(|line| line.tag).collect();
        assert!(tags.contains(&LineTag::Removed));
        assert!(tags.contains(&LineTag::Added));
    }

    #[test]
    fn accepting_all_hunks_yields_proposed() {
        let original = "a\nb\nc\n";
        let proposed = "a\nB\nc\nD\n";
        let hunks = diff(original, proposed);
        let all: Vec<usize> = hunks.iter().map(|hunk| hunk.id).collect();
        assert_eq!(merge_selected(original, proposed, &all), proposed);
    }

    #[test]
    fn accepting_no_hunks_yields_original() {
        let original = "a\nb\nc\n";
        let proposed = "a\nB\nc\nD\n";
        assert_eq!(merge_selected(original, proposed, &[]), original);
    }

    #[test]
    fn partial_acceptance_is_well_defined() {
        let original = "line1\nline2\nline3\n";
        let proposed = "LINE1\nline2\nLINE3\n";
        let hunks = diff(original, proposed);
        assert_eq!(hunks.len(), 2);
        // Accept only the first hunk: line1 changes, line3 stays original.
        let merged = merge_selected(original, proposed, &[0]);
        assert_eq!(merged, "LINE1\nline2\nline3\n");
    }
}
