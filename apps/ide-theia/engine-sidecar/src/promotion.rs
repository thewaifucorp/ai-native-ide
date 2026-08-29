//! §14 — promover um protótipo a durável, com a reconciliação que isso exige.
//!
//! `ide_modes::promote_prototype` já decidia o que uma promoção é: só existe em
//! Hybrid, precisa apontar para um checkpoint real, e nasce NÃO reconciliada.
//! Ninguém chamava. Este módulo é o consumidor, e o que ele acrescenta é a única
//! coisa que faltava para a regra valer: memória.
//!
//! # Por que "não reconciliada" é o estado inicial, e não um detalhe
//!
//! Em Hybrid, protótipo é o que se joga fora sem cerimônia; durável é o que o
//! projeto passa a sustentar. Promover é dizer "isto vira o que sustentamos" —
//! e no instante da promoção a intenção escrita do projeto ainda descreve o
//! mundo anterior. Marcar como reconciliado na hora esconderia exatamente a
//! divergência que a promoção CRIA.
//!
//! Por isso a promoção fica pendente até alguém dizer o que a resolveu. E a lista
//! de pendências é a resposta honesta para "o que este projeto promoveu e ainda
//! não explicou".
//!
//! # O que este módulo NÃO faz
//!
//! Não executa efeito nenhum, não mexe no broker e não promove nada sozinho.
//! Promover é ato de pessoa; o motor só recusa quando a regra não permite.

use ide_modes::{promote_prototype, PromotionRecord};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PROMOTIONS_REL: &str = ".instrument/promotions.json";

/// Uma promoção como ela ficou registrada.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    pub prototype_effect_id: String,
    pub checkpoint_effect_id: String,
    pub note: String,
    /// Falso até alguém dizer o que resolveu a divergência.
    pub reconciled: bool,
    /// Como foi resolvida, quando foi. Texto de pessoa, não rótulo do motor.
    pub reconciliation: Option<String>,
    pub at_epoch_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionSnapshot {
    /// O modo do projeto agora — promover só existe em Hybrid.
    pub mode: String,
    /// Por que não dá para promover agora, quando não dá.
    pub blocked_reason: Option<String>,
    pub promotions: Vec<Promotion>,
    /// Quantas ainda devem uma explicação.
    pub pending: usize,
    pub path: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    promotions: Vec<Promotion>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn path_of(root: &Path) -> PathBuf {
    root.join(PROMOTIONS_REL)
}

fn read(root: &Path) -> Result<Stored, String> {
    let path = path_of(root);
    if !path.exists() {
        return Ok(Stored::default());
    }
    let raw = fs::read(&path).map_err(|error| format!("ler {}: {error}", path.display()))?;
    serde_json::from_slice(&raw).map_err(|error| format!("{} ilegível: {error}", path.display()))
}

fn write(root: &Path, stored: &Stored) -> Result<(), String> {
    let path = path_of(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("criar {}: {error}", parent.display()))?;
    }
    let json = serde_json::to_vec_pretty(stored).map_err(|error| error.to_string())?;
    fs::write(&path, json).map_err(|error| format!("gravar {}: {error}", path.display()))
}

/// O modo do projeto, pelo mesmo `.instrument/config.json` do §13.
fn current_mode(root: &Path) -> Result<ide_config::BuildMode, String> {
    let store = ide_config::ConfigStore::open(root.join(".instrument"))
        .map_err(|error| format!("{error:#}"))?;
    Ok(store.config().mode.value)
}

fn mode_name(mode: ide_config::BuildMode) -> &'static str {
    match mode {
        ide_config::BuildMode::FullVibes => "full_vibes",
        ide_config::BuildMode::Hybrid => "hybrid",
        ide_config::BuildMode::Spec => "spec",
    }
}

pub fn snapshot(root: &Path) -> Result<PromotionSnapshot, String> {
    let mode = current_mode(root)?;
    let stored = read(root)?;
    let pending = stored.promotions.iter().filter(|p| !p.reconciled).count();
    Ok(PromotionSnapshot {
        blocked_reason: (mode != ide_config::BuildMode::Hybrid).then(|| {
            format!(
                "promover só existe em Hybrid, e este projeto está em {}. Os outros modos não \
                 têm a distinção descartável × durável para reconciliar: em Full Vibes tudo é \
                 rascunho, em Spec o contrato vem antes",
                mode_label(mode)
            )
        }),
        mode: mode_name(mode).to_string(),
        promotions: stored.promotions,
        pending,
        path: PROMOTIONS_REL.to_string(),
    })
}

fn mode_label(mode: ide_config::BuildMode) -> &'static str {
    match mode {
        ide_config::BuildMode::FullVibes => "Full Vibes",
        ide_config::BuildMode::Hybrid => "Hybrid",
        ide_config::BuildMode::Spec => "Spec",
    }
}

/// Promove um protótipo. Quem decide se pode é o `ide_modes`; aqui só registra.
pub fn promote(
    root: &Path,
    prototype_effect_id: &str,
    checkpoint_effect_id: &str,
    note: &str,
) -> Result<PromotionSnapshot, String> {
    if prototype_effect_id.trim().is_empty() {
        return Err(
            "promover pede QUAL protótipo: sem o efeito, a promoção não aponta para nada"
                .to_string(),
        );
    }
    let mode = current_mode(root)?;
    let registro: PromotionRecord =
        promote_prototype(mode, prototype_effect_id, checkpoint_effect_id, note).map_err(
            |erro| match erro {
                ide_modes::PromotionError::NotHybrid => format!(
                    "promover só existe em Hybrid, e este projeto está em {}",
                    mode_label(mode)
                ),
                ide_modes::PromotionError::MissingCheckpoint => {
                    "promover exige o checkpoint que segura o estado anterior — sem ele, \
                     desfazer a promoção não teria para onde voltar"
                        .to_string()
                }
            },
        )?;

    let mut stored = read(root)?;
    if stored
        .promotions
        .iter()
        .any(|p| p.prototype_effect_id == registro.prototype_effect_id)
    {
        return Err(format!(
            "{} já foi promovido: promover duas vezes criaria duas dívidas de reconciliação \
             para a mesma mudança",
            registro.prototype_effect_id
        ));
    }
    stored.promotions.push(Promotion {
        prototype_effect_id: registro.prototype_effect_id,
        checkpoint_effect_id: registro.checkpoint_effect_id,
        note: registro.note,
        // O motor nasce não reconciliado, e a tela não pode "melhorar" isso.
        reconciled: registro.reconciled,
        reconciliation: None,
        at_epoch_secs: now_secs(),
    });
    write(root, &stored)?;
    snapshot(root)
}

/// Fecha a dívida da promoção dizendo o que a resolveu.
pub fn reconcile(
    root: &Path,
    prototype_effect_id: &str,
    how: &str,
) -> Result<PromotionSnapshot, String> {
    if how.trim().is_empty() {
        return Err(
            "reconciliar pede o que MUDOU para o protótipo virar durável — sem isso, marcar \
             como resolvido apenas apaga a pergunta"
                .to_string(),
        );
    }
    let mut stored = read(root)?;
    let alvo = stored
        .promotions
        .iter_mut()
        .find(|p| p.prototype_effect_id == prototype_effect_id)
        .ok_or_else(|| format!("não há promoção registrada para {prototype_effect_id}"))?;
    if alvo.reconciled {
        return Err(format!(
            "{prototype_effect_id} já estava reconciliado: {}",
            alvo.reconciliation.clone().unwrap_or_default()
        ));
    }
    alvo.reconciled = true;
    alvo.reconciliation = Some(how.to_string());
    write(root, &stored)?;
    snapshot(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_config::{BuildMode, ConfigPatch, ConfigStore};

    fn projeto(mode: BuildMode) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut store = ConfigStore::open(dir.path().join(".instrument")).expect("store");
        store
            .apply_patch(ConfigPatch {
                mode: Some(mode),
                ..ConfigPatch::default()
            })
            .expect("patch");
        dir
    }

    /// A promoção nasce DEVENDO explicação: é a divergência que ela mesma criou.
    #[test]
    fn promover_registra_pendente_e_a_lista_diz_quantas_faltam() {
        let dir = projeto(BuildMode::Hybrid);

        let depois = promote(
            dir.path(),
            "efeito-proto",
            "efeito-checkpoint",
            "virou o caminho real",
        )
        .expect("promover");

        assert_eq!(depois.promotions.len(), 1);
        assert!(!depois.promotions[0].reconciled);
        assert_eq!(depois.pending, 1);
        assert!(
            dir.path().join(PROMOTIONS_REL).exists(),
            "promoção sem memória não é regra"
        );
    }

    /// Fora de Hybrid a promoção não significa nada, e a recusa diz o modo.
    #[test]
    fn promover_fora_de_hybrid_e_recusado_dizendo_o_modo() {
        for (mode, nome) in [
            (BuildMode::FullVibes, "Full Vibes"),
            (BuildMode::Spec, "Spec"),
        ] {
            let dir = projeto(mode);

            let erro = promote(dir.path(), "efeito", "checkpoint", "nota").expect_err("recusa");

            assert!(erro.contains(nome), "a recusa tem de dizer o modo: {erro}");
            let estado = snapshot(dir.path()).expect("snapshot");
            assert!(estado.blocked_reason.is_some());
        }
    }

    /// Sem checkpoint, desfazer a promoção não teria para onde voltar.
    #[test]
    fn promover_sem_checkpoint_e_recusado() {
        let dir = projeto(BuildMode::Hybrid);

        let erro = promote(dir.path(), "efeito", "  ", "nota").expect_err("recusa");

        assert!(erro.contains("checkpoint"));
    }

    #[test]
    fn promover_o_mesmo_efeito_duas_vezes_e_recusado() {
        let dir = projeto(BuildMode::Hybrid);
        promote(dir.path(), "efeito", "checkpoint", "nota").expect("primeira");

        let erro = promote(dir.path(), "efeito", "checkpoint", "nota").expect_err("recusa");

        assert!(erro.contains("já foi promovido"));
    }

    /// Reconciliar sem dizer o que mudou apaga a pergunta em vez de respondê-la.
    #[test]
    fn reconciliar_exige_o_que_mudou_e_depois_fecha_a_divida() {
        let dir = projeto(BuildMode::Hybrid);
        promote(dir.path(), "efeito", "checkpoint", "nota").expect("promover");

        let erro = reconcile(dir.path(), "efeito", "   ").expect_err("recusa");
        assert!(erro.contains("MUDOU"));

        let depois = reconcile(dir.path(), "efeito", "intenção reescrita no SoT do leilão")
            .expect("reconciliar");

        assert_eq!(depois.pending, 0);
        assert!(depois.promotions[0].reconciled);
        assert_eq!(
            depois.promotions[0].reconciliation.as_deref(),
            Some("intenção reescrita no SoT do leilão")
        );

        let de_novo = reconcile(dir.path(), "efeito", "outra coisa").expect_err("já resolvido");
        assert!(de_novo.contains("já estava reconciliado"));
    }

    /// O estado sobrevive ao processo: é disso que a regra dependia.
    #[test]
    fn a_promocao_sobrevive_a_releitura() {
        let dir = projeto(BuildMode::Hybrid);
        promote(dir.path(), "efeito", "checkpoint", "nota").expect("promover");

        let lido = snapshot(dir.path()).expect("snapshot");

        assert_eq!(lido.promotions.len(), 1);
        assert_eq!(lido.pending, 1);
        assert_eq!(lido.mode, "hybrid");
    }
}
