//! §13 — serviços e ambientes como REFERÊNCIAS, não como pasta.
//!
//! O `project.rs` declarava esta lacuna em voz alta: o recurso durável do motor
//! é um diretório canônico, e dar um diretório a um serviço para caber no schema
//! seria inventar fato. O tipo que faltava existe desde sempre em
//! `ide-references` e não tinha consumidor — este módulo é ele.
//!
//! # Por que não é o mesmo que as "referências" do §5
//!
//! Parece duplicação e não é. As referências do §5 (`.product/references/*.json`)
//! são MATERIAL do projeto — um documento, um asset, uma URL citada — com
//! procedência, e passam pelo broker porque viram conteúdo versionado. Estas são
//! ENDEREÇOS: um serviço que roda em algum lugar, um ambiente. Não têm caminho,
//! não têm bytes para versionar e por isso não passam pelo broker nem pelo
//! observador — o que existe delas é o registro de que o projeto depende delas.
//!
//! # O que este módulo se recusa a fazer
//!
//! Não fala com o endpoint. Registrar `https://api.exemplo` não diz que a API
//! existe, está de pé ou responde; diz que este projeto declara depender dela.
//! Qualquer "status" aqui seria inventado, então não há nenhum.

use ide_references::{ProjectReference, ReferenceKind, ReferenceRegistry};
use serde::Serialize;
use std::path::Path;

use crate::project;

/// Onde o registro vive: estado durável do IDE para este projeto.
const REGISTRY_REL: &str = ".instrument/references";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferencesSnapshot {
    /// Referências deste projeto. Vazio enquanto ele não for durável.
    pub references: Vec<ProjectReference>,
    /// `None` quando a pasta ainda não é um projeto durável — referência é
    /// ligada a um projeto, e não existe projeto para ligar.
    pub project_id: Option<String>,
    pub blocked_reason: Option<String>,
    pub registry_path: String,
    /// Dito na própria resposta: registrar não é verificar.
    pub note: String,
}

fn kind_of(value: &str) -> Result<ReferenceKind, String> {
    match value {
        "service" => Ok(ReferenceKind::Service),
        "environment" => Ok(ReferenceKind::Environment),
        other => Err(format!(
            "tipo de referência desconhecido: {other} (service ou environment)"
        )),
    }
}

fn registry(root: &Path) -> Result<ReferenceRegistry, String> {
    ReferenceRegistry::open(root.join(REGISTRY_REL)).map_err(|error| format!("{error:#}"))
}

fn project_id(root: &Path) -> Result<Option<String>, String> {
    Ok(project::snapshot(root)?.project.map(|record| record.id.0))
}

fn snapshot_of(root: &Path) -> Result<ReferencesSnapshot, String> {
    let id = project_id(root)?;
    let references = match &id {
        Some(id) => registry(root)?.for_project(id),
        None => Vec::new(),
    };
    Ok(ReferencesSnapshot {
        blocked_reason: id.is_none().then(|| {
            "referência é ligada a um projeto durável, e esta pasta ainda não é um: \
             registrar o projeto vem primeiro"
                .to_string()
        }),
        project_id: id,
        references,
        registry_path: format!("{REGISTRY_REL}/references.json"),
        note: "registrar uma referência declara dependência; não diz que o serviço \
               está de pé — nada aqui chama o endpoint"
            .to_string(),
    })
}

pub fn snapshot(root: &Path) -> Result<ReferencesSnapshot, String> {
    snapshot_of(root)
}

/// Liga um serviço ou ambiente a este projeto. O mesmo id ligado por outro
/// projeto é REUSADO, não duplicado — é o ponto de uma referência ser
/// compartilhada.
pub fn link(
    root: &Path,
    id: &str,
    kind: &str,
    name: &str,
    endpoint: &str,
) -> Result<ReferencesSnapshot, String> {
    let kind = kind_of(kind)?;
    if id.trim().is_empty() || name.trim().is_empty() || endpoint.trim().is_empty() {
        return Err("referência precisa de id, nome e endpoint".to_string());
    }
    let project = project_id(root)?.ok_or_else(|| {
        "esta pasta ainda não é um projeto durável: não há a que ligar a referência".to_string()
    })?;
    registry(root)?
        .link(id.trim(), kind, name.trim(), endpoint.trim(), &project)
        .map_err(|error| format!("{error:#}"))?;
    snapshot_of(root)
}

/// Desliga a referência DESTE projeto. Ela continua existindo para os outros
/// projetos que a ligam — desligar não é apagar de todo mundo.
pub fn unlink(root: &Path, id: &str) -> Result<ReferencesSnapshot, String> {
    let project = project_id(root)?
        .ok_or_else(|| "esta pasta ainda não é um projeto durável".to_string())?;
    let mut registry = registry(root)?;
    registry
        .unlink(id, &project)
        .map_err(|error| format!("{error:#}"))?;
    snapshot_of(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registered() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        project::register(dir.path(), "Leilão", "construir um leilão").expect("register");
        dir
    }

    #[test]
    fn a_folder_without_a_durable_project_says_why_and_refuses() {
        let dir = tempfile::tempdir().expect("tempdir");

        let snapshot = snapshot(dir.path()).expect("snapshot");
        assert!(snapshot.blocked_reason.is_some());
        assert!(snapshot.references.is_empty());

        let error = link(dir.path(), "svc:api", "service", "API", "https://x").expect_err("recusa");
        assert!(error.contains("projeto durável"));
    }

    #[test]
    fn a_service_is_linked_with_an_endpoint_and_no_path() {
        let dir = registered();

        let snapshot = link(dir.path(), "svc:api", "service", "API", "https://api.exemplo")
            .expect("ligar");

        assert_eq!(snapshot.references.len(), 1);
        assert_eq!(snapshot.references[0].endpoint, "https://api.exemplo");
        assert_eq!(snapshot.references[0].kind, ReferenceKind::Service);
    }

    /// Registrar não é verificar, e a resposta diz isso sem ninguém perguntar.
    #[test]
    fn the_snapshot_states_that_registering_is_not_checking() {
        let dir = registered();

        let snapshot = snapshot(dir.path()).expect("snapshot");

        assert!(snapshot.note.contains("não diz que o serviço"));
    }

    #[test]
    fn linking_twice_reuses_the_same_reference_instead_of_duplicating() {
        let dir = registered();
        link(dir.path(), "svc:api", "service", "API", "https://api.exemplo").expect("1");

        let snapshot =
            link(dir.path(), "svc:api", "service", "API", "https://api.exemplo").expect("2");

        assert_eq!(snapshot.references.len(), 1);
    }

    #[test]
    fn unlinking_removes_it_from_this_project() {
        let dir = registered();
        link(dir.path(), "env:staging", "environment", "Staging", "staging").expect("ligar");

        let snapshot = unlink(dir.path(), "env:staging").expect("desligar");

        assert!(snapshot.references.is_empty());
    }

    #[test]
    fn an_unknown_kind_fails_instead_of_guessing() {
        let dir = registered();

        let error = link(dir.path(), "x", "banco", "X", "y").expect_err("deve falhar");

        assert!(error.contains("tipo de referência desconhecido"));
    }
}
