//! §9 — Features, Tasks e Status, com o status calculado pelo motor.
//!
//! Este módulo é a metade que toca disco: lê os artefatos de trabalho que o
//! provider do harness declara, mede o material que as provas citam, e entrega
//! os dois para o `ide_work`, que decide. Ele não escolhe status nenhum.
//!
//! # Por que os itens são arquivos
//!
//! É a mesma regra do contrato do harness (§1): um item de trabalho é um ARQUIVO
//! no projeto, revisável num diff e sobrevivente a uma reinstalação do IDE.
//! Escrever um item — a pessoa ou um agente — é escrever um arquivo; não há
//! outra porta, e por isso não existe estado de trabalho escondido num banco que
//! só o IDE lê.
//!
//! # Frescor: o mesmo padrão do §8, não um novo
//!
//! A prova guarda o hash do material sobre o qual foi tirada, com o
//! `ide_semantic::content_hash` que o §8 já usa para intenção. Se o material
//! mudou, a prova fica `evidence_stale`. Um assunto que este módulo NÃO
//! conseguiu medir não vira "inalterado": vai como não observado, e desconhecido
//! nunca conta como aprovado.

use ide_semantic::content_hash;
use ide_work::{report, WorkItem, WorkReport};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Onde os itens do provider padrão vivem, relativo à raiz do projeto.
pub const ITEMS_DIR_REL: &str = ".harness/items";

/// Um arquivo de item que não pôde ser lido — e o motivo. Um arquivo quebrado é
/// um fato sobre o projeto, não um item a menos em silêncio.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProblem {
    pub path: String,
    pub problem: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSnapshot {
    pub items: Vec<WorkItem>,
    /// Statuses e problemas de hierarquia, direto do motor.
    #[serde(flatten)]
    pub report: WorkReport,
    /// Arquivos ilegíveis, com o motivo de cada um.
    pub unreadable: Vec<ItemProblem>,
    /// Assunto -> hash medido agora. Vai para a tela porque é a evidência de que
    /// o frescor foi medido, e não afirmado.
    pub observed: BTreeMap<String, String>,
    pub items_dir: String,
}

fn confine(root: &Path, subject: &str) -> Option<PathBuf> {
    let candidate = root.join(subject);
    let canonical = candidate.canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    canonical.starts_with(&root).then_some(canonical)
}

/// Mede agora o material que as provas citam.
///
/// Só assunto que é ARQUIVO dentro do projeto é medido. O resto fica de fora do
/// mapa de propósito: o motor trata ausência como frescor desconhecido, que é a
/// resposta honesta para "não consegui olhar".
fn observe(root: &Path, items: &[WorkItem]) -> BTreeMap<String, String> {
    let mut observed = BTreeMap::new();
    for item in items {
        for criterion in &item.criteria {
            let Some(evidence) = &criterion.evidence else {
                continue;
            };
            if observed.contains_key(&evidence.subject) {
                continue;
            }
            let Some(path) = confine(root, &evidence.subject) else {
                continue;
            };
            if let Ok(bytes) = fs::read(&path) {
                let text = String::from_utf8_lossy(&bytes);
                observed.insert(evidence.subject.clone(), content_hash(&text));
            }
        }
    }
    observed
}

/// Lê os itens, mede o material e devolve o que o motor calculou.
pub fn snapshot(root: &Path) -> Result<WorkSnapshot, String> {
    let dir = root.join(ITEMS_DIR_REL);
    let mut items = Vec::new();
    let mut unreadable = Vec::new();

    if dir.exists() {
        let entries =
            fs::read_dir(&dir).map_err(|error| format!("ler {}: {error}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let rel = format!(
                "{ITEMS_DIR_REL}/{}",
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            match fs::read(&path) {
                Ok(bytes) => match serde_json::from_slice::<WorkItem>(&bytes) {
                    Ok(item) if item.id.trim().is_empty() => unreadable.push(ItemProblem {
                        path: rel,
                        problem: "item sem id: nada pode apontar para ele".to_string(),
                    }),
                    Ok(item) => items.push(item),
                    Err(error) => unreadable.push(ItemProblem {
                        path: rel,
                        problem: format!("JSON inválido: {error}"),
                    }),
                },
                Err(error) => unreadable.push(ItemProblem {
                    path: rel,
                    problem: format!("ilegível: {error}"),
                }),
            }
        }
    }

    items.sort_by(|a, b| a.id.cmp(&b.id));
    unreadable.sort_by(|a, b| a.path.cmp(&b.path));
    let observed = observe(root, &items);
    let report = report(&items, &observed);
    Ok(WorkSnapshot {
        items,
        report,
        unreadable,
        observed,
        items_dir: ITEMS_DIR_REL.to_string(),
    })
}

/// Grava um item. Existe por conveniência — escrever o mesmo JSON à mão, ou por
/// um agente, tem exatamente o mesmo efeito, e `snapshot` acha os dois.
///
/// Note o que este caminho NÃO aceita: status. Não há campo para ele no item,
/// então não há como escrever um. É a única garantia que faz "status é
/// calculado" ser verdade em vez de convenção.
pub fn write_item(root: &Path, item: WorkItem) -> Result<WorkSnapshot, String> {
    if item.id.trim().is_empty() {
        return Err("item precisa de id".to_string());
    }
    if item.id.contains(['/', '\\', '.']) {
        return Err(format!(
            "id de item não pode conter '/', '\\' nem '.': {}",
            item.id
        ));
    }
    let dir = root.join(ITEMS_DIR_REL);
    fs::create_dir_all(&dir).map_err(|error| format!("criar {}: {error}", dir.display()))?;
    let file = dir.join(format!("{}.json", item.id));
    let json = serde_json::to_vec_pretty(&item).map_err(|error| error.to_string())?;
    fs::write(&file, json).map_err(|error| format!("gravar {}: {error}", file.display()))?;
    snapshot(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_work::{Criterion, Evidence, WorkKind, WorkStatus};

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn task_with_proof(subject: &str, hash: &str) -> WorkItem {
        WorkItem {
            id: "t1".to_string(),
            title: "primeira task".to_string(),
            kind: WorkKind::Task,
            parents: Vec::new(),
            criteria: vec![Criterion {
                id: "c1".to_string(),
                text: "o arquivo existe e passa".to_string(),
                evidence: Some(Evidence {
                    passed: true,
                    at_ms: 1,
                    subject: subject.to_string(),
                    subject_hash: hash.to_string(),
                    note: "rodou".to_string(),
                }),
                proposed: false,
            }],
            implementation: vec![subject.to_string()],
            blocked: None,
        }
    }

    fn status_of(snapshot: &WorkSnapshot, id: &str) -> WorkStatus {
        snapshot
            .report
            .statuses
            .iter()
            .find(|s| s.id == id)
            .expect("status")
            .status
    }

    #[test]
    fn a_project_without_items_reports_nothing_instead_of_failing() {
        let dir = project();

        let snapshot = snapshot(dir.path()).expect("snapshot");

        assert!(snapshot.items.is_empty());
        assert!(snapshot.report.statuses.is_empty());
        assert_eq!(snapshot.items_dir, ITEMS_DIR_REL);
    }

    /// O ciclo inteiro no disco: prova fresca vira `verified`, e editar o
    /// material torna a mesma prova `evidence_stale` sem ninguém tocar no item.
    #[test]
    fn editing_the_material_turns_a_verified_item_stale_by_itself() {
        let dir = project();
        fs::write(dir.path().join("alvo.md"), "conteúdo provado\n").unwrap();
        let hash = content_hash("conteúdo provado\n");
        write_item(dir.path(), task_with_proof("alvo.md", &hash)).expect("gravar item");

        let fresh = snapshot(dir.path()).expect("snapshot");
        assert_eq!(status_of(&fresh, "t1"), WorkStatus::Verified);

        fs::write(dir.path().join("alvo.md"), "outra coisa\n").unwrap();

        let after = snapshot(dir.path()).expect("snapshot");
        assert_eq!(status_of(&after, "t1"), WorkStatus::EvidenceStale);
    }

    #[test]
    fn a_subject_outside_the_project_is_not_observed_and_never_counts_as_fresh() {
        let dir = project();
        write_item(dir.path(), task_with_proof("../fora.md", "qualquer")).expect("gravar");

        let snapshot = snapshot(dir.path()).expect("snapshot");

        assert!(snapshot.observed.is_empty());
        assert_eq!(status_of(&snapshot, "t1"), WorkStatus::EvidenceStale);
    }

    #[test]
    fn an_unreadable_item_file_is_reported_instead_of_dropped() {
        let dir = project();
        let items = dir.path().join(ITEMS_DIR_REL);
        fs::create_dir_all(&items).unwrap();
        fs::write(items.join("quebrado.json"), "{ isto não é json").unwrap();

        let snapshot = snapshot(dir.path()).expect("snapshot");

        assert_eq!(snapshot.unreadable.len(), 1);
        assert!(snapshot.unreadable[0].problem.contains("JSON inválido"));
    }

    #[test]
    fn an_item_id_that_escapes_the_items_directory_is_refused() {
        let dir = project();
        let mut item = task_with_proof("alvo.md", "h");
        item.id = "../fora".to_string();

        let error = write_item(dir.path(), item).expect_err("deve recusar");

        assert!(error.contains("não pode conter"));
    }

    /// Não há campo de status no artefato, então gravar um status é impossível
    /// por construção. Este teste existe para o dia em que alguém tentar.
    #[test]
    fn the_artifact_has_no_status_field_to_write() {
        let dir = project();
        write_item(dir.path(), task_with_proof("alvo.md", "h")).expect("gravar");

        let raw = fs::read_to_string(dir.path().join(ITEMS_DIR_REL).join("t1.json")).unwrap();

        assert!(!raw.contains("\"status\""));
    }
}
