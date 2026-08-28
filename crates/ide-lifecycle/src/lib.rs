//! Free, portable version/export/publish lifecycle for the AI-Native IDE.
//!
//! # Consolidar e publicar são passos diferentes
//!
//! **Consolidar** uma versão é local: congela "esta é a 0.0.3, corrige tal
//! problema, tocou tais recursos" no registro do projeto. Nada sai da máquina.
//! **Publicar** leva a versão para um destino real, e é o único dos dois com
//! efeito externo — logo, o único que não tem undo.
//!
//! Os dois estavam no mesmo passo, chamado "publicar", e a pessoa lia "meu
//! produto foi para o ar" quando o que acontecia era uma linha num arquivo
//! local. [`RecordKind`] é o que mantém as duas coisas distinguíveis no registro.
//!
//! O caminho essencial é local-first e livre: o projeto exporta um manifesto
//! portátil, sem infraestrutura ShinAI obrigatória e sem lock-in. O primeiro
//! efeito externo irreversível exige confirmação explícita na hora. Uma versão
//! pode ser reaberta, ligada ao problema observado e sucedida por outra — o
//! histórico é preservado, nunca sobrescrito.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedResource {
    pub id: String,
    pub kind: String,
    /// A portable, workspace-relative label — never an absolute machine path.
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInputs {
    pub project_id: String,
    pub title: String,
    pub intent: String,
    pub version: String,
    pub resources: Vec<ExportedResource>,
    pub applied_guidance: Vec<String>,
    pub applied_packs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub project_id: String,
    pub title: String,
    pub intent: String,
    pub version: String,
    pub resources: Vec<ExportedResource>,
    pub applied_guidance: Vec<String>,
    pub applied_packs: Vec<String>,
    pub portability_note: String,
}

/// Builds a portable manifest. It records only workspace-relative resource
/// labels and declares its own portability, so an export never depends on a
/// specific machine path or on ShinAI infrastructure.
pub fn build_export_manifest(inputs: &ExportInputs) -> ExportManifest {
    ExportManifest {
        project_id: inputs.project_id.clone(),
        title: inputs.title.clone(),
        intent: inputs.intent.clone(),
        version: inputs.version.clone(),
        resources: inputs.resources.clone(),
        applied_guidance: inputs.applied_guidance.clone(),
        applied_packs: inputs.applied_packs.clone(),
        portability_note:
            "Export local e portável; nenhuma infraestrutura ShinAI é obrigatória para reabrir."
                .to_owned(),
    }
}

/// Increments the patch component of a `major.minor.patch` version, defaulting
/// missing components to zero. A non-numeric version starts a fresh `0.0.1`.
pub fn bump_patch(version: &str) -> String {
    let mut parts = version.split('.').map(|part| part.parse::<u64>().ok());
    let major = parts.next().flatten().unwrap_or(0);
    let minor = parts.next().flatten().unwrap_or(0);
    let patch = parts.next().flatten().unwrap_or(0);
    format!("{major}.{minor}.{}", patch + 1)
}

/// How far a lifecycle effect can be undone. Modeled honestly: an external
/// publication is never a true undo, so it is never `Reversible`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reversibility {
    /// The effect can be fully undone, leaving no trace (e.g. deleting a local
    /// exported file).
    Reversible,
    /// The effect cannot be undone, but its impact can be mitigated by a further
    /// compensating action (e.g. publishing a retraction or a corrected
    /// version). Not a rollback.
    CompensationOnly,
    /// The effect cannot be undone and no compensating action exists.
    Irreversible,
}

/// Where an external publication lands, which decides whether it can be
/// compensated at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishTarget {
    /// A registry that accepts further publications, so a mistake can be
    /// compensated by publishing a retraction or a corrected version.
    ExternalCompensable,
    /// A sink that cannot be amended or retracted once written, so no
    /// compensating action is possible.
    ExternalImmutable,
}

/// A lifecycle effect whose reversibility and compensation we can reason about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "effect")]
pub enum LifecycleEffect {
    /// A local export produced a deletable file at this portable path.
    LocalExport { path: String },
    /// Consolidating a version: a durable LOCAL record that this is version X,
    /// what problem it fixes and what it touched. Nothing leaves the machine.
    ///
    /// ── POR QUE É UM EFEITO SEPARADO ──────────────────────────────────────
    /// Consolidar e publicar estavam no mesmo passo, e o passo se chamava
    /// "publicar" — a pessoa lia "meu produto foi para o ar" quando o que
    /// acontecia era uma linha num registro local. Separar é o que devolve
    /// significado às duas palavras: consolidar congela a versão; publicar leva
    /// para um destino, por um adapter, e SÓ ele é efeito externo.
    ConsolidateVersion { project_id: String, version: String },
    /// A first external publication of a version.
    Publish {
        project_id: String,
        version: String,
        target: PublishTarget,
    },
    /// A republication of a new version over a previous one.
    Republish {
        project_id: String,
        version: String,
        target: PublishTarget,
    },
    /// An annotated Git tag created LOCALLY for a consolidated version.
    ///
    /// Criar a tag e empurrá-la são atos separados de propósito: a tag local não
    /// saiu da máquina e apagá-la é undo de verdade. Juntá-los faria o ato
    /// reversível carregar o peso do irreversível.
    CreateLocalTag { tag: String },
    /// A tag pushed to a remote — o primeiro efeito externo real deste caminho.
    PushTag { tag: String, remote: String },
    /// A GitHub release created for a tag already on the remote.
    CreateGithubRelease { tag: String },
}

impl LifecycleEffect {
    /// Classifies how far this effect can be undone, independently of whether a
    /// concrete compensation plan is available.
    pub fn reversibility(&self) -> Reversibility {
        match self {
            LifecycleEffect::LocalExport { .. } => Reversibility::Reversible,
            // Local, mas não apagável: o registro de versões é o que responde
            // "o que aconteceu com este projeto". Apagar uma linha dele seria
            // reescrever a história; o que existe é consolidar uma versão
            // corrigida por cima.
            LifecycleEffect::ConsolidateVersion { .. } => Reversibility::CompensationOnly,
            // Tag local não saiu da máquina: apagar não deixa rastro.
            LifecycleEffect::CreateLocalTag { .. } => Reversibility::Reversible,
            // Empurrada, a tag pode ter sido buscada por qualquer um antes de
            // ser apagada. Apagar no remoto mitiga; não desfaz.
            LifecycleEffect::PushTag { .. } | LifecycleEffect::CreateGithubRelease { .. } => {
                Reversibility::CompensationOnly
            }
            LifecycleEffect::Publish { target, .. } | LifecycleEffect::Republish { target, .. } => {
                match target {
                    PublishTarget::ExternalCompensable => Reversibility::CompensationOnly,
                    PublishTarget::ExternalImmutable => Reversibility::Irreversible,
                }
            }
        }
    }
}

/// The concrete compensating action for an effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompensationKind {
    /// Delete the exported file — a true undo.
    DeleteExportedFile,
    /// Publish a compensating version (a retraction or a corrected version).
    /// This mitigates but never truly undoes the original publication.
    PublishCompensatingVersion,
    /// Consolidate a corrected version over a wrong one, in the local record.
    /// The wrong version stays in the history — that is the point of a record.
    ConsolidateCorrectedVersion,
    /// Delete the local tag — a true undo, nothing left it.
    DeleteLocalTag,
    /// Delete the tag on the remote. Mitigates; whoever already fetched it keeps
    /// their copy, so it is never a rollback.
    DeleteRemoteTag,
    /// Delete the GitHub release. The tag itself survives unless deleted too.
    DeleteGithubRelease,
}

/// A concrete, honest description of what can be undone and how. A plan is only
/// produced when a real compensating action exists; a truly irreversible effect
/// with no compensation yields no plan (see [`compensation_for`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompensationPlan {
    pub reversibility: Reversibility,
    pub kind: CompensationKind,
    /// The concrete target the compensating action operates on: the exported
    /// file path, or the `project_id@version` being compensated.
    pub target: String,
    /// A human-readable, honest note describing the compensating action.
    pub note: String,
}

/// Describes the concrete compensating action for a lifecycle effect, or `None`
/// when the effect is irreversible and no compensation is possible.
///
/// Honest degradation: this never fabricates a rollback. A local export is a
/// true undo (delete the file); an external publication is compensation-only
/// (publish a retraction or corrected version); an immutable external sink
/// returns `None`, and callers must report that no undo exists rather than
/// pretend otherwise.
pub fn compensation_for(effect: &LifecycleEffect) -> Option<CompensationPlan> {
    match effect {
        LifecycleEffect::LocalExport { path } => Some(CompensationPlan {
            reversibility: Reversibility::Reversible,
            kind: CompensationKind::DeleteExportedFile,
            target: path.clone(),
            note: "Excluir o arquivo exportado desfaz o export por completo.".to_owned(),
        }),
        LifecycleEffect::ConsolidateVersion {
            project_id,
            version,
        } => Some(CompensationPlan {
            reversibility: Reversibility::CompensationOnly,
            kind: CompensationKind::ConsolidateCorrectedVersion,
            target: format!("{project_id}@{version}"),
            note: "Consolidar uma versão corrigida por cima; a versão errada continua \
                   no registro, que é para isso que ele serve."
                .to_owned(),
        }),
        LifecycleEffect::CreateLocalTag { tag } => Some(CompensationPlan {
            reversibility: Reversibility::Reversible,
            kind: CompensationKind::DeleteLocalTag,
            target: tag.clone(),
            note: format!("Apagar a tag local {tag} desfaz por completo: ela nunca saiu daqui."),
        }),
        LifecycleEffect::PushTag { tag, remote } => Some(CompensationPlan {
            reversibility: Reversibility::CompensationOnly,
            kind: CompensationKind::DeleteRemoteTag,
            target: format!("{remote}/{tag}"),
            note: format!(
                "Apagar {tag} em {remote} mitiga, mas não desfaz: quem já buscou a tag \
                 continua com ela, e quem depende dela verá o histórico mudar."
            ),
        }),
        LifecycleEffect::CreateGithubRelease { tag } => Some(CompensationPlan {
            reversibility: Reversibility::CompensationOnly,
            kind: CompensationKind::DeleteGithubRelease,
            target: tag.clone(),
            note: format!(
                "Apagar a release de {tag} no GitHub tira a página e os anexos; a tag \
                 continua no remoto, e quem já baixou continua com o que baixou."
            ),
        }),
        LifecycleEffect::Publish {
            project_id,
            version,
            target,
        }
        | LifecycleEffect::Republish {
            project_id,
            version,
            target,
        } => match target {
            PublishTarget::ExternalCompensable => Some(CompensationPlan {
                reversibility: Reversibility::CompensationOnly,
                kind: CompensationKind::PublishCompensatingVersion,
                target: format!("{project_id}@{version}"),
                note: "Publicação externa não tem undo real; \
                       compensar publicando uma retratação ou versão corrigida."
                    .to_owned(),
            }),
            PublishTarget::ExternalImmutable => None,
        },
    }
}

/// O que uma linha do registro é: uma versão consolidada localmente, ou uma
/// publicação externa.
///
/// O default de desserialização é `Published` de propósito. Registros gravados
/// antes desta separação nasceram do passo que se chamava "publicar" e se
/// declarava externo; lê-los como consolidação local mudaria, retroativamente, o
/// que aquelas linhas afirmam ter acontecido.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    /// Versão congelada no registro local. Nada saiu da máquina.
    Consolidated,
    /// Publicação externa, por um destino declarado.
    Published,
}

fn default_record_kind() -> RecordKind {
    RecordKind::Published
}

/// Onde uma versão foi parar, de fato.
///
/// ── POR QUE FICA NA LINHA DA VERSÃO ───────────────────────────────────────
/// Publicar não cria versão nova: publica UMA versão que já existe. Registrar a
/// publicação como outra linha faria o projeto ganhar uma 0.0.5 sem que nada
/// tenha mudado nele — e a pergunta "esta versão está no ar?" deixaria de ter
/// resposta. Cada destino alcançado é um item aqui, com a compensação que
/// aquele destino realmente tem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    /// Que destino foi alcançado: `git-tag`, `github-release`, …
    pub target: String,
    /// A referência concreta: `origin/v0.0.4`, a URL da release.
    pub reference: String,
    /// Quando, em segundos desde a época. Sem isto, duas publicações da mesma
    /// versão viram uma só na leitura.
    pub at_epoch_secs: u64,
    /// A compensação daquele destino, ou `None` quando não existe nenhuma.
    pub compensation: Option<CompensationPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRecord {
    pub project_id: String,
    pub version: String,
    /// Consolidação local ou publicação externa — ver [`RecordKind`].
    #[serde(default = "default_record_kind")]
    pub kind: RecordKind,
    /// Present only when this version fixed an observed problem (a republish).
    pub problem: Option<String>,
    /// Resources related to the problem being fixed.
    pub related_resources: Vec<String>,
    pub note: String,
    /// How far this publication can be undone. Evidence carried on the record
    /// itself, so an auditor sees the honest reversibility class.
    #[serde(default = "default_publish_reversibility")]
    pub reversibility: Reversibility,
    /// The concrete compensating action, or `None` when this publication is
    /// irreversible with no compensation possible.
    #[serde(default)]
    pub compensation: Option<CompensationPlan>,
    /// Os destinos que esta versão realmente alcançou. Vazio = consolidada e
    /// nada mais: ela existe no projeto e não está em lugar nenhum.
    #[serde(default)]
    pub deployments: Vec<Deployment>,
}

fn default_publish_reversibility() -> Reversibility {
    Reversibility::CompensationOnly
}

/// What the IDE must do before an external effect. The first irreversible
/// external effect always requires an explicit confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmationDecision {
    Proceed,
    ConfirmFirst,
}

pub fn confirmation_for(irreversible: bool, already_confirmed: bool) -> ConfirmationDecision {
    if irreversible && !already_confirmed {
        ConfirmationDecision::ConfirmFirst
    } else {
        ConfirmationDecision::Proceed
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PublishSnapshot {
    records: BTreeMap<String, Vec<PublishRecord>>,
}

pub struct PublishLog {
    path: PathBuf,
    records: BTreeMap<String, Vec<PublishRecord>>,
}

impl PublishLog {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .with_context(|| format!("create lifecycle directory {}", root.display()))?;
        let path = root.join("publications.json");
        let snapshot = if path.exists() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            serde_json::from_slice::<PublishSnapshot>(&bytes)
                .with_context(|| format!("parse {}", path.display()))?
        } else {
            PublishSnapshot::default()
        };
        Ok(Self {
            path,
            records: snapshot.records,
        })
    }

    pub fn history(&self, project_id: &str) -> Vec<PublishRecord> {
        self.records.get(project_id).cloned().unwrap_or_default()
    }

    fn latest_version(&self, project_id: &str) -> Option<String> {
        self.records
            .get(project_id)
            .and_then(|records| records.last())
            .map(|record| record.version.clone())
    }

    /// Consolidates the next version in the LOCAL record: this is version X, and
    /// (when it fixes something) what problem it fixes and what it touched.
    ///
    /// Nothing leaves the machine here. Publishing to a real destination is a
    /// separate act, performed by an adapter, and it is the only one that carries
    /// an external effect.
    pub fn consolidate(
        &mut self,
        project_id: &str,
        problem: Option<&str>,
        related_resources: Vec<String>,
    ) -> anyhow::Result<PublishRecord> {
        let version = match self.latest_version(project_id) {
            Some(previous) => bump_patch(&previous),
            None => "0.0.1".to_owned(),
        };
        let effect = LifecycleEffect::ConsolidateVersion {
            project_id: project_id.to_owned(),
            version: version.clone(),
        };
        let record = PublishRecord {
            project_id: project_id.to_owned(),
            version,
            kind: RecordKind::Consolidated,
            problem: problem.map(str::to_owned),
            related_resources,
            note: match problem {
                Some(_) => "Versão consolidada corrigindo um problema observado.".to_owned(),
                None => "Versão consolidada no registro local do projeto.".to_owned(),
            },
            reversibility: effect.reversibility(),
            compensation: compensation_for(&effect),
            deployments: Vec::new(),
        };
        self.records
            .entry(project_id.to_owned())
            .or_default()
            .push(record.clone());
        self.persist()?;
        Ok(record)
    }

    /// Publishes the next version to a compensable registry. The first
    /// publication is `0.0.1`; later ones bump the patch of the latest recorded
    /// version.
    pub fn publish(&mut self, project_id: &str) -> anyhow::Result<PublishRecord> {
        self.publish_to(project_id, PublishTarget::ExternalCompensable)
    }

    /// Publishes to a named target.
    ///
    /// The target is what decides whether the publication can be compensated at
    /// all, so a caller that publishes into an immutable sink must be able to say
    /// so — otherwise the record would claim a compensation plan that does not
    /// exist, which is the one thing this module is written to prevent.
    pub fn publish_to(
        &mut self,
        project_id: &str,
        target: PublishTarget,
    ) -> anyhow::Result<PublishRecord> {
        let version = match self.latest_version(project_id) {
            Some(previous) => bump_patch(&previous),
            None => "0.0.1".to_owned(),
        };
        let effect = LifecycleEffect::Publish {
            project_id: project_id.to_owned(),
            version: version.clone(),
            target,
        };
        let record = PublishRecord {
            project_id: project_id.to_owned(),
            version,
            kind: RecordKind::Published,
            problem: None,
            related_resources: Vec::new(),
            note: match target {
                PublishTarget::ExternalCompensable => {
                    "Publicação em destino que aceita correção posterior.".to_owned()
                }
                PublishTarget::ExternalImmutable => {
                    "Publicação em destino imutável: sem undo e sem compensação.".to_owned()
                }
            },
            reversibility: effect.reversibility(),
            compensation: compensation_for(&effect),
            deployments: Vec::new(),
        };
        self.records
            .entry(project_id.to_owned())
            .or_default()
            .push(record.clone());
        self.persist()?;
        Ok(record)
    }

    /// Republishes after observing a problem: it relates the fix to the problem
    /// and to the affected resources, and bumps the version — the previous
    /// versions stay in the history.
    pub fn republish(
        &mut self,
        project_id: &str,
        problem: &str,
        related_resources: Vec<String>,
    ) -> anyhow::Result<PublishRecord> {
        self.republish_to(
            project_id,
            problem,
            related_resources,
            PublishTarget::ExternalCompensable,
        )
    }

    /// Republishes to a named target. Same reason as [`PublishLog::publish_to`]:
    /// the target decides whether a compensation exists, so it cannot be assumed.
    pub fn republish_to(
        &mut self,
        project_id: &str,
        problem: &str,
        related_resources: Vec<String>,
        target: PublishTarget,
    ) -> anyhow::Result<PublishRecord> {
        let version = match self.latest_version(project_id) {
            Some(previous) => bump_patch(&previous),
            None => anyhow::bail!("cannot republish a project that was never published"),
        };
        let effect = LifecycleEffect::Republish {
            project_id: project_id.to_owned(),
            version: version.clone(),
            target,
        };
        let record = PublishRecord {
            project_id: project_id.to_owned(),
            version,
            kind: RecordKind::Published,
            problem: Some(problem.to_owned()),
            related_resources,
            note: "Republicação corrigindo um problema observado.".to_owned(),
            reversibility: effect.reversibility(),
            compensation: compensation_for(&effect),
            deployments: Vec::new(),
        };
        self.records
            .entry(project_id.to_owned())
            .or_default()
            .push(record.clone());
        self.persist()?;
        Ok(record)
    }

    /// Anota, na linha da versão, um destino que ela alcançou.
    ///
    /// Falha quando a versão não existe: registrar publicação de uma versão que
    /// nunca foi consolidada afirmaria que foi para o ar algo que o projeto não
    /// congelou.
    pub fn record_deployment(
        &mut self,
        project_id: &str,
        version: &str,
        deployment: Deployment,
    ) -> anyhow::Result<PublishRecord> {
        let record = self
            .records
            .get_mut(project_id)
            .and_then(|records| records.iter_mut().find(|entry| entry.version == version))
            .ok_or_else(|| {
                anyhow::anyhow!("versão {version} não está consolidada em {project_id}")
            })?;
        record.deployments.push(deployment);
        let updated = record.clone();
        self.persist()?;
        Ok(updated)
    }

    /// Remove um destino da linha da versão, depois que a compensação dele foi
    /// executada de verdade. Devolve `true` quando havia o que remover.
    pub fn forget_deployment(
        &mut self,
        project_id: &str,
        version: &str,
        target: &str,
        reference: &str,
    ) -> anyhow::Result<bool> {
        let record = self
            .records
            .get_mut(project_id)
            .and_then(|records| records.iter_mut().find(|entry| entry.version == version))
            .ok_or_else(|| {
                anyhow::anyhow!("versão {version} não está consolidada em {project_id}")
            })?;
        let before = record.deployments.len();
        record
            .deployments
            .retain(|entry| !(entry.target == target && entry.reference == reference));
        let removed = record.deployments.len() != before;
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    fn persist(&self) -> anyhow::Result<()> {
        let snapshot = PublishSnapshot {
            records: self.records.clone(),
        };
        let json = serde_json::to_vec_pretty(&snapshot)?;
        fs::write(&self.path, json).with_context(|| format!("write {}", self.path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ide-lifecycle-{tag}-{}", std::process::id()))
    }

    #[test]
    fn export_manifest_is_portable_and_has_no_absolute_paths() {
        let manifest = build_export_manifest(&ExportInputs {
            project_id: "auction".to_owned(),
            title: "Leilão".to_owned(),
            intent: "construir um leilão".to_owned(),
            version: "0.0.1".to_owned(),
            resources: vec![ExportedResource {
                id: "r1".to_owned(),
                kind: "repository".to_owned(),
                label: "app".to_owned(),
            }],
            applied_guidance: vec!["guidance-000001".to_owned()],
            applied_packs: vec!["auction-starter".to_owned()],
        });
        assert!(manifest.portability_note.contains("portável"));
        assert!(!manifest.resources[0].label.starts_with('/'));
    }

    #[test]
    fn first_irreversible_external_effect_requires_confirmation() {
        assert_eq!(
            confirmation_for(true, false),
            ConfirmationDecision::ConfirmFirst
        );
        assert_eq!(confirmation_for(true, true), ConfirmationDecision::Proceed);
        assert_eq!(
            confirmation_for(false, false),
            ConfirmationDecision::Proceed
        );
    }

    /// Consolidar é local, e o registro tem de dizer isso de três formas que não
    /// dependem de leitura de texto: a classe do efeito, a compensação oferecida
    /// e o `kind` da linha. Se qualquer uma delas dissesse "externo", a tela
    /// voltaria a prometer um deploy que não aconteceu.
    #[test]
    fn consolidar_e_local_e_nao_se_declara_publicacao_externa() {
        let root = temp_root("consolidate");
        let _ = fs::remove_dir_all(&root);
        let mut log = PublishLog::open(&root).unwrap();

        let first = log.consolidate("auction", None, vec![]).unwrap();
        assert_eq!(first.version, "0.0.1");
        assert_eq!(first.kind, RecordKind::Consolidated);
        assert_eq!(
            first.compensation.as_ref().map(|plan| plan.kind),
            Some(CompensationKind::ConsolidateCorrectedVersion),
            "a compensação de consolidar é consolidar corrigido, não publicar retratação"
        );

        let second = log
            .consolidate(
                "auction",
                Some("lance mínimo não era respeitado"),
                vec!["resource:abc".to_owned()],
            )
            .unwrap();
        assert_eq!(second.version, "0.0.2");
        assert_eq!(
            second.problem.as_deref(),
            Some("lance mínimo não era respeitado")
        );
        assert_eq!(second.related_resources, vec!["resource:abc".to_owned()]);
        assert_eq!(log.history("auction").len(), 2, "a versão anterior fica");

        let _ = fs::remove_dir_all(&root);
    }

    /// Registro gravado antes da separação nasceu do passo externo. Lê-lo como
    /// consolidação local mudaria, retroativamente, o que a linha afirma.
    #[test]
    fn registro_antigo_sem_kind_continua_sendo_publicacao_externa() {
        let raw = r#"{
            "projectId": "auction",
            "version": "0.0.1",
            "problem": null,
            "relatedResources": [],
            "note": "Publicação em destino que aceita correção posterior.",
            "reversibility": "compensation_only"
        }"#;

        let record: PublishRecord = serde_json::from_str(raw).unwrap();

        assert_eq!(record.kind, RecordKind::Published);
    }

    /// Os três atos do release têm classes DIFERENTES, e é por isso que são três.
    #[test]
    fn tag_local_e_reversivel_e_empurrar_nao_e() {
        let local = LifecycleEffect::CreateLocalTag {
            tag: "v0.0.4".to_owned(),
        };
        let empurrada = LifecycleEffect::PushTag {
            tag: "v0.0.4".to_owned(),
            remote: "origin".to_owned(),
        };
        let release = LifecycleEffect::CreateGithubRelease {
            tag: "v0.0.4".to_owned(),
        };

        assert_eq!(local.reversibility(), Reversibility::Reversible);
        assert_eq!(empurrada.reversibility(), Reversibility::CompensationOnly);
        assert_eq!(release.reversibility(), Reversibility::CompensationOnly);

        let plano = compensation_for(&empurrada).expect("apagar no remoto mitiga");
        assert_eq!(plano.kind, CompensationKind::DeleteRemoteTag);
        assert!(
            plano.note.contains("não desfaz"),
            "quem já buscou a tag continua com ela, e a frase tem de dizer isso: {}",
            plano.note
        );
    }

    /// Publicar não cria versão: publica uma que já existe. Se virasse linha
    /// nova, o projeto ganharia uma 0.0.5 sem nada ter mudado nele.
    #[test]
    fn destino_alcancado_entra_na_linha_da_versao_e_nao_cria_outra() {
        let root = temp_root("deployment");
        let _ = fs::remove_dir_all(&root);
        let mut log = PublishLog::open(&root).unwrap();
        log.consolidate("auction", None, vec![]).unwrap();

        let atualizado = log
            .record_deployment(
                "auction",
                "0.0.1",
                Deployment {
                    target: "git-tag".to_owned(),
                    reference: "origin/v0.0.1".to_owned(),
                    at_epoch_secs: 1_700_000_000,
                    compensation: compensation_for(&LifecycleEffect::PushTag {
                        tag: "v0.0.1".to_owned(),
                        remote: "origin".to_owned(),
                    }),
                },
            )
            .unwrap();

        assert_eq!(atualizado.deployments.len(), 1);
        assert_eq!(log.history("auction").len(), 1, "nenhuma versão nova");
        assert!(atualizado.deployments[0].compensation.is_some());

        // A compensação executada de verdade tira o destino da linha.
        assert!(log
            .forget_deployment("auction", "0.0.1", "git-tag", "origin/v0.0.1")
            .unwrap());
        assert!(log.history("auction")[0].deployments.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    /// Registrar destino de uma versão que ninguém consolidou afirmaria que foi
    /// para o ar algo que o projeto nunca congelou.
    #[test]
    fn destino_de_versao_inexistente_e_recusado() {
        let root = temp_root("deployment-orfao");
        let _ = fs::remove_dir_all(&root);
        let mut log = PublishLog::open(&root).unwrap();

        let erro = log
            .record_deployment(
                "auction",
                "9.9.9",
                Deployment {
                    target: "git-tag".to_owned(),
                    reference: "origin/v9.9.9".to_owned(),
                    at_epoch_secs: 0,
                    compensation: None,
                },
            )
            .expect_err("deve recusar");

        assert!(erro.to_string().contains("não está consolidada"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bump_patch_increments_and_tolerates_garbage() {
        assert_eq!(bump_patch("1.2.3"), "1.2.4");
        assert_eq!(bump_patch("1"), "1.0.1");
        assert_eq!(bump_patch("garbage"), "0.0.1");
    }

    #[test]
    fn publish_then_republish_preserves_history_and_links_problem() {
        let root = temp_root("publish");
        let _ = fs::remove_dir_all(&root);
        let mut log = PublishLog::open(&root).unwrap();
        let first = log.publish("auction").unwrap();
        assert_eq!(first.version, "0.0.1");
        let republished = log
            .republish("auction", "leaderboard vazava id", vec!["r1".to_owned()])
            .unwrap();
        assert_eq!(republished.version, "0.0.2");
        assert_eq!(
            republished.problem.as_deref(),
            Some("leaderboard vazava id")
        );
        let history = log.history("auction");
        assert_eq!(history.len(), 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn local_export_is_reversible_with_delete_compensation() {
        let effect = LifecycleEffect::LocalExport {
            path: "exports/auction.json".to_owned(),
        };
        assert_eq!(effect.reversibility(), Reversibility::Reversible);
        let plan = compensation_for(&effect).expect("local export has a compensation plan");
        assert_eq!(plan.reversibility, Reversibility::Reversible);
        assert_eq!(plan.kind, CompensationKind::DeleteExportedFile);
        assert_eq!(plan.target, "exports/auction.json");
    }

    #[test]
    fn external_compensable_publish_is_compensation_only_with_version_plan() {
        let effect = LifecycleEffect::Publish {
            project_id: "auction".to_owned(),
            version: "0.0.1".to_owned(),
            target: PublishTarget::ExternalCompensable,
        };
        assert_eq!(effect.reversibility(), Reversibility::CompensationOnly);
        let plan = compensation_for(&effect).expect("compensable publish has a plan");
        assert_eq!(plan.reversibility, Reversibility::CompensationOnly);
        assert_eq!(plan.kind, CompensationKind::PublishCompensatingVersion);
        assert_eq!(plan.target, "auction@0.0.1");
    }

    #[test]
    fn immutable_external_publish_is_irreversible_with_explicit_no_compensation() {
        let effect = LifecycleEffect::Publish {
            project_id: "auction".to_owned(),
            version: "0.0.1".to_owned(),
            target: PublishTarget::ExternalImmutable,
        };
        assert_eq!(effect.reversibility(), Reversibility::Irreversible);
        assert!(
            compensation_for(&effect).is_none(),
            "an immutable publish must honestly report no compensation, not a fake rollback"
        );
    }

    #[test]
    fn publish_record_carries_reversibility_and_compensation_evidence() {
        let root = temp_root("compensation");
        let _ = fs::remove_dir_all(&root);
        let mut log = PublishLog::open(&root).unwrap();
        let record = log.publish("auction").unwrap();
        assert_eq!(record.reversibility, Reversibility::CompensationOnly);
        let plan = record
            .compensation
            .expect("record carries a compensation plan");
        assert_eq!(plan.kind, CompensationKind::PublishCompensatingVersion);
        assert_eq!(plan.target, "auction@0.0.1");
        fs::remove_dir_all(&root).unwrap();
    }

    /// An immutable target must reach the RECORD as irreversible with no plan.
    /// Recording it as compensable would put a compensation on the receipt that
    /// nobody can perform.
    #[test]
    fn publishing_to_an_immutable_target_records_no_compensation() {
        let root = temp_root("immutable");
        let _ = fs::remove_dir_all(&root);
        let mut log = PublishLog::open(&root).unwrap();

        let record = log
            .publish_to("auction", PublishTarget::ExternalImmutable)
            .unwrap();

        assert_eq!(record.reversibility, Reversibility::Irreversible);
        assert!(record.compensation.is_none());
        assert!(record.note.contains("imutável"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn republish_without_publish_is_rejected() {
        let root = temp_root("republish");
        let _ = fs::remove_dir_all(&root);
        let mut log = PublishLog::open(&root).unwrap();
        assert!(log.republish("nope", "x", vec![]).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
