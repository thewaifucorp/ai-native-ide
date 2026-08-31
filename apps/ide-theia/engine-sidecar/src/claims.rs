//! §17 — quem está com a tarefa AGORA, e o portão que decide se pode pegar.
//!
//! Este módulo é a diferença entre um chat com quadro de tarefas e uma camada de
//! ciclo de vida. Ele não coordena conversa entre agentes: ele responde uma
//! pergunta só — **este agente pode começar esta tarefa?** — e a resposta é NÃO
//! com motivo na maior parte dos casos interessantes.
//!
//! ── POR QUE A POSSE NÃO É CAMPO DO ITEM ───────────────────────────────────
//! O item de trabalho (`.harness/items/<id>.json`) é artefato versionado: ele
//! diz o que se quer, o critério, quem está DESIGNADO. Quem está executando
//! agora é outra coisa — morre quando a IDE fecha e não faz sentido no diff de
//! ninguém. Então a posse é arquivo de runtime em `.instrument/claims/`, e o
//! item continua sem nenhum campo que uma execução escreva.
//!
//! ── A POSSE É DA EXECUÇÃO, NÃO DO AGENTE ──────────────────────────────────
//! O arquivo guarda o PID do sidecar que tomou a posse. Se aquele processo não
//! existe mais, a posse é órfã e o próximo pedido a adota, dizendo que adotou.
//! Sem isso, fechar a IDE no meio de uma tarefa a deixaria trancada para sempre,
//! e a pessoa aprenderia a apagar arquivo na mão — que é como um mecanismo de
//! posse morre.
//!
//! ── O PORTÃO ──────────────────────────────────────────────────────────────
//! Pegar uma tarefa é recusado quando:
//!
//! 1. **Ela não existe.**
//! 2. **Ela não tem critério de aceite.** Sem critério, "pronto" é opinião: não
//!    existe nada contra o que a evidência do agente possa ser conferida. É a
//!    recusa mais importante daqui.
//! 3. **Ela está bloqueada**, e o motivo declarado vai na recusa.
//! 4. **Alguém vivo está com ela.** Nunca se rouba, e nunca se espera em fila.
//!
//! O plano de verificação (FEAT-04) NÃO bloqueia pegar: ele é proposto depois de
//! pegar e antes de executar. Quem cobra o plano é o portão de execução, não o
//! de posse — ver [`may_execute`].

use ide_work::{plan_state, PlanState, WorkItem};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Onde as posses vivem. Runtime do IDE, não conteúdo do projeto.
const CLAIMS_DIR_REL: &str = ".instrument/claims";

/// Quem está com uma tarefa agora.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub item_id: String,
    pub agent_id: String,
    /// PID do sidecar que tomou a posse. É o que separa posse viva de órfã.
    pub pid: u32,
    pub at_epoch_secs: u64,
}

/// O que aconteceu ao pedir a tarefa.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub claim: Claim,
    /// Verdadeiro quando a posse anterior era de uma execução morta e foi
    /// adotada. Dito porque a pessoa precisa saber que havia trabalho a meio.
    pub adopted_orphan: bool,
    /// Quem era o dono da posse órfã adotada, quando houve uma.
    pub previous_agent: Option<String>,
}

fn claims_dir(root: &Path) -> PathBuf {
    root.join(CLAIMS_DIR_REL)
}

fn claim_file(root: &Path, item_id: &str) -> PathBuf {
    claims_dir(root).join(format!("{item_id}.json"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// O processo ainda existe?
///
/// `/proc` no Linux; noutros unixes, `kill -0`. Um "não sei" responde `true` —
/// tratar posse desconhecida como morta seria roubar a tarefa de alguém vivo,
/// que é o erro mais caro dos dois.
#[cfg(unix)]
fn pid_vivo(pid: u32) -> bool {
    if Path::new(&format!("/proc/{pid}")).exists() {
        return true;
    }
    if Path::new("/proc").exists() {
        // Tem /proc e o pid não está lá: morreu de verdade.
        return false;
    }
    std::process::Command::new("kill")
        .args(["-s", "0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(true)
}

#[cfg(not(unix))]
fn pid_vivo(_pid: u32) -> bool {
    true
}

fn ler(root: &Path, item_id: &str) -> Option<Claim> {
    let raw = fs::read_to_string(claim_file(root, item_id)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Todas as posses vivas. As órfãs são varridas aqui, porque uma lista que mostra
/// dono morto ensina a pessoa a desconfiar da lista inteira.
pub fn snapshot(root: &Path) -> Result<Vec<Claim>, String> {
    let dir = claims_dir(root);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|error| format!("ler {}: {error}", dir.display()))?;
    let mut vivas = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        match serde_json::from_str::<Claim>(&raw) {
            Ok(claim) if pid_vivo(claim.pid) => vivas.push(claim),
            Ok(_) => {
                let _ = fs::remove_file(&path);
            }
            // Arquivo de posse ilegível é posse que ninguém consegue provar: some,
            // senão tranca a tarefa para sempre sem dono identificável.
            Err(_) => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    vivas.sort_by(|a, b| a.item_id.cmp(&b.item_id));
    Ok(vivas)
}

/// Pega a tarefa para um agente, ou diz por que não dá.
///
/// `item` é o item já lido do disco pelo chamador — este módulo não escolhe o
/// que é um item, do mesmo jeito que o motor do §9 não lê disco.
pub fn claim(root: &Path, item: &WorkItem, agent_id: &str) -> Result<ClaimOutcome, String> {
    if agent_id.trim().is_empty() {
        return Err("é preciso dizer qual agente está pegando a tarefa".to_string());
    }

    // O portão que faz esta camada valer: sem critério de aceite não existe
    // contra o que conferir a evidência, e "pronto" viraria declaração do agente.
    let contaveis = item.criteria.iter().filter(|c| !c.proposed).count();
    if contaveis == 0 {
        let propostos = item.criteria.len();
        return Err(format!(
            "a task '{}' não tem critério de aceite{}: sem critério não há como \
             verificar o trabalho, e 'pronto' viraria opinião de quem fez. \
             Escreva o critério antes de entregar a task a um agente.",
            item.id,
            if propostos > 0 {
                format!(" adotado ({propostos} proposto(s) por agente, que não contam)")
            } else {
                String::new()
            }
        ));
    }

    if let Some(motivo) = &item.blocked {
        return Err(format!(
            "a task '{}' está bloqueada e não pode ser começada: {motivo}",
            item.id
        ));
    }

    let anterior = ler(root, &item.id);
    let mut adopted_orphan = false;
    let mut previous_agent = None;
    if let Some(atual) = anterior {
        if pid_vivo(atual.pid) {
            if atual.agent_id == agent_id {
                // Já é dele: pegar de novo é idempotente, não é conflito.
                return Ok(ClaimOutcome {
                    claim: atual,
                    adopted_orphan: false,
                    previous_agent: None,
                });
            }
            return Err(format!(
                "a task '{}' já está com o agente '{}' (execução {}): pegue outra. \
                 Duas execuções na mesma task é o jeito de duas mudarem o mesmo arquivo.",
                item.id, atual.agent_id, atual.pid
            ));
        }
        adopted_orphan = true;
        previous_agent = Some(atual.agent_id);
    }

    let claim = Claim {
        item_id: item.id.clone(),
        agent_id: agent_id.to_string(),
        pid: std::process::id(),
        at_epoch_secs: now_secs(),
    };
    let dir = claims_dir(root);
    fs::create_dir_all(&dir).map_err(|error| format!("criar {}: {error}", dir.display()))?;
    let file = claim_file(root, &item.id);
    let json = serde_json::to_vec_pretty(&claim).map_err(|error| error.to_string())?;
    fs::write(&file, json).map_err(|error| format!("gravar {}: {error}", file.display()))?;

    Ok(ClaimOutcome {
        claim,
        adopted_orphan,
        previous_agent,
    })
}

/// Solta a tarefa. Só o dono solta — soltar a de outro seria roubar pela porta
/// dos fundos.
pub fn release(root: &Path, item_id: &str, agent_id: &str) -> Result<(), String> {
    match ler(root, item_id) {
        None => Ok(()),
        Some(atual) if atual.agent_id == agent_id => {
            let file = claim_file(root, item_id);
            fs::remove_file(&file).map_err(|error| format!("soltar {}: {error}", file.display()))
        }
        Some(atual) => Err(format!(
            "a task '{item_id}' está com '{}', não com '{agent_id}'",
            atual.agent_id
        )),
    }
}

/// O portão de EXECUÇÃO: o agente já tem a tarefa, mas pode escrever código?
///
/// Aqui é onde o plano de verificação (FEAT-04) é cobrado. Um agente que executa
/// sem plano aceito é um agente que decide sozinho o que vai contar como prova
/// do próprio trabalho — que é exatamente o que esta camada existe para impedir.
pub fn may_execute(item: &WorkItem) -> Result<(), String> {
    match plan_state(item) {
        PlanState::Accepted => Ok(()),
        PlanState::Missing => Err(format!(
            "a task '{}' não tem plano de verificação: o agente propõe COMO vai provar, \
             e alguém aceita, antes de escrever código.",
            item.id
        )),
        PlanState::Proposed => Err(format!(
            "o plano de verificação da task '{}' ainda não foi aceito por ninguém: \
             quem executa não adota o próprio contrato.",
            item.id
        )),
        PlanState::Outdated => Err(format!(
            "os critérios da task '{}' mudaram depois do plano aceito. O plano antigo \
             continua no artefato; escreva uma revisão nova sobre os critérios de agora.",
            item.id
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_work::{Criterion, PlanCriterionRef, PlanRevision, WorkKind};

    fn criterio(id: &str, text: &str) -> Criterion {
        Criterion {
            id: id.to_string(),
            text: text.to_string(),
            evidence: None,
            proposed: false,
        }
    }

    fn task(id: &str, criterios: Vec<Criterion>) -> WorkItem {
        WorkItem {
            id: id.to_string(),
            title: format!("task {id}"),
            kind: WorkKind::Task,
            parents: Vec::new(),
            criteria: criterios,
            implementation: Vec::new(),
            blocked: None,
            assignee: None,
            verification_plan: Vec::new(),
        }
    }

    /// A recusa que dá sentido à camada inteira.
    #[test]
    fn task_sem_criterio_de_aceite_nao_pode_ser_pega() {
        let dir = tempfile::tempdir().expect("dir");

        let erro = claim(dir.path(), &task("t1", Vec::new()), "coder").expect_err("tem de recusar");

        assert!(erro.contains("critério de aceite"), "{erro}");
        assert!(erro.contains("opinião"), "o erro explica POR QUE: {erro}");
    }

    /// Critério proposto por agente não abre o portão — senão o agente destrava a
    /// própria task escrevendo o critério que ele mesmo vai cumprir.
    #[test]
    fn criterio_proposto_por_agente_nao_abre_o_portao() {
        let dir = tempfile::tempdir().expect("dir");
        let mut proposto = criterio("c1", "eu decido o que é pronto");
        proposto.proposed = true;

        let erro = claim(dir.path(), &task("t1", vec![proposto]), "coder").expect_err("recusa");

        assert!(erro.contains("proposto"), "{erro}");
    }

    #[test]
    fn task_bloqueada_nao_comeca_e_a_recusa_diz_o_motivo() {
        let dir = tempfile::tempdir().expect("dir");
        let mut t = task("t1", vec![criterio("c1", "salva")]);
        t.blocked = Some("esperando a API do parceiro".to_string());

        let erro = claim(dir.path(), &t, "coder").expect_err("recusa");

        assert!(erro.contains("esperando a API do parceiro"), "{erro}");
    }

    #[test]
    fn dois_agentes_na_mesma_task_o_segundo_e_recusado() {
        let dir = tempfile::tempdir().expect("dir");
        let t = task("t1", vec![criterio("c1", "salva")]);

        let primeiro = claim(dir.path(), &t, "coder").expect("primeiro pega");
        assert!(!primeiro.adopted_orphan);

        let erro = claim(dir.path(), &t, "tester").expect_err("segundo é recusado");
        assert!(erro.contains("já está com o agente 'coder'"), "{erro}");

        // O mesmo agente pegar de novo é idempotente, não conflito.
        claim(dir.path(), &t, "coder").expect("mesmo agente pega de novo");
    }

    /// Fechar a IDE no meio não pode trancar a task para sempre.
    #[test]
    fn posse_de_execucao_morta_e_adotada_e_a_adocao_e_dita() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();
        let t = task("t1", vec![criterio("c1", "salva")]);

        // Posse de um PID que não existe: é o que sobra depois de um kill.
        fs::create_dir_all(claims_dir(root)).expect("dir");
        let morta = Claim {
            item_id: "t1".to_string(),
            agent_id: "coder".to_string(),
            pid: 4_294_000_000,
            at_epoch_secs: 1,
        };
        fs::write(
            claim_file(root, "t1"),
            serde_json::to_vec_pretty(&morta).expect("json"),
        )
        .expect("gravar");

        let resultado = claim(root, &t, "tester").expect("adota a órfã");

        assert!(resultado.adopted_orphan);
        assert_eq!(resultado.previous_agent.as_deref(), Some("coder"));
        assert_eq!(resultado.claim.agent_id, "tester");
    }

    #[test]
    fn so_o_dono_solta_a_task() {
        let dir = tempfile::tempdir().expect("dir");
        let t = task("t1", vec![criterio("c1", "salva")]);
        claim(dir.path(), &t, "coder").expect("pega");

        let erro = release(dir.path(), "t1", "tester").expect_err("não é dele");
        assert!(erro.contains("está com 'coder'"), "{erro}");

        release(dir.path(), "t1", "coder").expect("o dono solta");
        assert!(snapshot(dir.path()).expect("listar").is_empty());
    }

    #[test]
    fn a_lista_de_posses_varre_as_orfas() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();
        claim(root, &task("viva", vec![criterio("c1", "x")]), "coder").expect("pega");
        fs::write(
            claim_file(root, "morta"),
            serde_json::to_vec_pretty(&Claim {
                item_id: "morta".to_string(),
                agent_id: "outro".to_string(),
                pid: 4_294_000_000,
                at_epoch_secs: 1,
            })
            .expect("json"),
        )
        .expect("gravar");

        let vivas = snapshot(root).expect("listar");

        assert_eq!(vivas.len(), 1);
        assert_eq!(vivas[0].item_id, "viva");
    }

    // ── portão de execução ──────────────────────────────────────────────────

    fn plano(criterios: &[Criterion], accepted: bool) -> PlanRevision {
        PlanRevision {
            at_ms: 1,
            by: "coder".to_string(),
            steps: vec!["rodar os checks".to_string()],
            criteria: criterios
                .iter()
                .map(|c| PlanCriterionRef {
                    id: c.id.clone(),
                    text: c.text.clone(),
                })
                .collect(),
            accepted,
        }
    }

    #[test]
    fn executar_exige_plano_aceito_e_a_recusa_diz_qual_dos_casos_e() {
        let c1 = criterio("c1", "salva");
        let mut t = task("t1", vec![c1.clone()]);

        let erro = may_execute(&t).expect_err("sem plano");
        assert!(erro.contains("não tem plano de verificação"), "{erro}");

        t.verification_plan = vec![plano(std::slice::from_ref(&c1), false)];
        let erro = may_execute(&t).expect_err("plano não aceito");
        assert!(erro.contains("não adota o próprio contrato"), "{erro}");

        t.verification_plan = vec![plano(std::slice::from_ref(&c1), true)];
        may_execute(&t).expect("plano aceito libera");

        // Critério reescrito depois do aceite: o contrato de antes não cobre mais.
        t.criteria = vec![criterio("c1", "salva e mostra recibo")];
        let erro = may_execute(&t).expect_err("plano desatualizado");
        assert!(erro.contains("mudaram depois do plano aceito"), "{erro}");
    }
}
