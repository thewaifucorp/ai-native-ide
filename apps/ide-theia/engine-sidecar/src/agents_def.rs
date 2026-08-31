//! §17 — Project Agents: a DEFINIÇÃO, que é artefato do projeto.
//!
//! Um Project Agent aqui não é uma sessão, não é um processo e não é uma
//! credencial. É um arquivo versionado que diz **o papel, as instruções e por
//! qual adapter ele fala**. Quem abrir o repositório amanhã lê os agentes do
//! projeto no diff, do mesmo jeito que lê as fontes da verdade do §3.
//!
//! Por isso mora em `.product/agents/`, e não em `.instrument/`: `.instrument/`
//! é estado de runtime que o IDE propõe ignorar no Git. Uma definição que
//! desaparece ao trocar de máquina não é definição do projeto — é preferência de
//! quem estava sentado ali.
//!
//! ── O QUE UMA DEFINIÇÃO NÃO CARREGA ───────────────────────────────────────
//! Segredo nenhum. Nem token, nem chave, nem endpoint autenticado. O adapter é
//! citado pelo NOME (`codex`, `claude`, `acp`); a credencial dele continua onde
//! já estava, fora do projeto. Um arquivo que vai para o Git não pode ser o
//! lugar onde a chave de alguém vaza — foi assim que o experimento com o
//! Paperclip commitou uma `GROQ_API_KEY`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Onde as definições vivem, relativo à raiz do projeto.
pub const AGENTS_DIR_REL: &str = ".product/agents";

/// A definição de um Project Agent, exatamente como o arquivo declara.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    /// Id estável, e também o nome do arquivo.
    pub id: String,
    /// O papel em linguagem de gente: "implementa", "revisa", "testa".
    pub role: String,
    /// O que este agente deve fazer e o que não deve. Vai para o agente
    /// literalmente — ninguém reescreve o texto de outra pessoa.
    #[serde(default)]
    pub instructions: String,
    /// Nome do adapter preferido (`codex`, `claude`, `acp`, …). Preferência, não
    /// promessa: se ele não estiver disponível na máquina, a tela diz isso em vez
    /// de trocar em silêncio.
    #[serde(default)]
    pub adapter: Option<String>,
    /// Capabilities que este agente PRECISA para trabalhar (ids do §14).
    #[serde(default)]
    pub requires: Vec<String>,
}

/// Um arquivo de definição que não pôde ser lido, e o motivo. Arquivo quebrado é
/// fato sobre o projeto, não um agente a menos em silêncio.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProblem {
    pub path: String,
    pub problem: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsSnapshot {
    pub agents: Vec<AgentDefinition>,
    pub unreadable: Vec<AgentProblem>,
    pub dir: String,
}

fn agents_dir(root: &Path) -> PathBuf {
    root.join(AGENTS_DIR_REL)
}

/// Lê as definições do projeto. Diretório ausente é lista vazia — um projeto sem
/// agentes definidos é normal, não erro.
pub fn snapshot(root: &Path) -> Result<AgentsSnapshot, String> {
    let dir = agents_dir(root);
    let mut agents = Vec::new();
    let mut unreadable = Vec::new();

    if dir.exists() {
        let entries =
            fs::read_dir(&dir).map_err(|error| format!("ler {}: {error}", dir.display()))?;
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        paths.sort();
        for path in paths {
            let nome = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .display()
                .to_string();
            match fs::read_to_string(&path)
                .map_err(|error| error.to_string())
                .and_then(|raw| {
                    serde_json::from_str::<AgentDefinition>(&raw).map_err(|e| e.to_string())
                }) {
                Ok(agent) => agents.push(agent),
                Err(problem) => unreadable.push(AgentProblem {
                    path: nome,
                    problem,
                }),
            }
        }
    }

    Ok(AgentsSnapshot {
        agents,
        unreadable,
        dir: AGENTS_DIR_REL.to_string(),
    })
}

/// Grava uma definição. Escrever o mesmo JSON à mão tem exatamente o mesmo
/// efeito — não existe porta privilegiada.
pub fn write(root: &Path, agent: AgentDefinition) -> Result<AgentsSnapshot, String> {
    if agent.id.trim().is_empty() {
        return Err("agente precisa de id".to_string());
    }
    if agent.id.contains(['/', '\\', '.']) {
        return Err(format!(
            "id de agente não pode conter '/', '\\' nem '.': {}",
            agent.id
        ));
    }
    if agent.role.trim().is_empty() {
        return Err(format!(
            "o agente '{}' precisa de um papel: sem papel, a definição não diz o que ele faz",
            agent.id
        ));
    }
    let dir = agents_dir(root);
    fs::create_dir_all(&dir).map_err(|error| format!("criar {}: {error}", dir.display()))?;
    let file = dir.join(format!("{}.json", agent.id));
    let json = serde_json::to_vec_pretty(&agent).map_err(|error| error.to_string())?;
    fs::write(&file, json).map_err(|error| format!("gravar {}: {error}", file.display()))?;
    snapshot(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agente(id: &str) -> AgentDefinition {
        AgentDefinition {
            id: id.to_string(),
            role: "implementa o que a task pede".to_string(),
            instructions: "não mexa em migração de banco".to_string(),
            adapter: Some("codex".to_string()),
            requires: vec!["rust-lsp".to_string()],
        }
    }

    #[test]
    fn a_definicao_e_um_arquivo_do_projeto_e_volta_igual() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();

        let snap = write(root, agente("coder")).expect("gravar");

        assert_eq!(snap.agents.len(), 1);
        assert_eq!(snap.agents[0], agente("coder"));
        assert!(
            root.join(".product/agents/coder.json").exists(),
            "a definição vai para .product/, que é versionado — não para .instrument/"
        );
    }

    #[test]
    fn agente_sem_papel_e_recusado_em_vez_de_gravado_vazio() {
        let dir = tempfile::tempdir().expect("dir");
        let mut sem_papel = agente("x");
        sem_papel.role = "  ".to_string();

        let erro = write(dir.path(), sem_papel).expect_err("tem de recusar");

        assert!(erro.contains("papel"), "o erro diz o que falta: {erro}");
    }

    /// Um arquivo quebrado não pode virar "esse agente não existe": a tela tem de
    /// ver o arquivo e o motivo.
    #[test]
    fn definicao_ilegivel_aparece_como_problema_e_nao_some() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();
        write(root, agente("bom")).expect("gravar");
        fs::write(root.join(".product/agents/quebrado.json"), "{ não é json").expect("gravar");

        let snap = snapshot(root).expect("ler");

        assert_eq!(snap.agents.len(), 1);
        assert_eq!(snap.unreadable.len(), 1);
        assert!(snap.unreadable[0].path.contains("quebrado.json"));
    }
}
