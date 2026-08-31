//! Derrubar a ÁRVORE de um processo, não só o filho direto.
//!
//! Este módulo existe porque a mesma falha aconteceu duas vezes, e a segunda vez
//! foi minha: o `stop` respondia "parado" e a porta continuava atendendo.
//!
//! * No **preview** (§4), o comando declarado roda sob um `sh`, então o servidor
//!   é NETO do sidecar. Matar o `sh` deixava o servidor vivo — e a próxima
//!   execução sondava o zumbi e o via saudável.
//! * No **compartilhamento** (§16), o `nginx` roda com um master e workers.
//!   Matar o master deixava os workers segurando a porta: a tela dizia "fechado"
//!   e o endereço, exposto na rede, seguia respondendo. Foi medido com um GET de
//!   fora, DEPOIS de clicar em "parar de mostrar".
//!
//! As duas armadilhas do caminho, aprendidas quebrando:
//!
//! 1. **Só sinalizar o grupo se o filho for LÍDER dele.** Um filho que herdou o
//!    grupo do pai faz `kill -- -pid` acertar o grupo de quem iniciou o sidecar
//!    — ou seja, derruba o terminal e o backend do IDE junto. Aconteceu.
//! 2. **O `--` não é enfeite.** Sem ele o `/bin/kill` lê `-2093347` como opção,
//!    não faz nada, e sai com código 0: uma falha silenciosa que faz o `stop`
//!    responder de consciência limpa enquanto o processo segue de pé.

use std::process::{Command, Stdio};
use std::time::Duration;

/// Põe o comando em um grupo próprio, para que a árvore inteira possa ser
/// derrubada depois. Sem isto, [`kill_tree`] não tem o que sinalizar com
/// segurança.
#[cfg(unix)]
pub fn own_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
pub fn own_group(_command: &mut Command) {}

/// Verdadeiro quando o processo é líder do próprio grupo — a única condição em
/// que sinalizar o grupo é seguro.
#[cfg(unix)]
fn is_group_leader(pid: i32) -> bool {
    Command::new("ps")
        .args(["-o", "pgid=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|text| text.trim().parse::<i32>().ok())
        .is_some_and(|pgid| pgid == pid)
}

#[cfg(unix)]
fn signal_group(pid: i32, sig: &str) {
    let _ = Command::new("kill")
        .args(["-s", sig, "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(unix)]
fn group_alive(pid: i32) -> bool {
    Command::new("kill")
        .args(["-s", "0", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Derruba a árvore do processo e SÓ VOLTA quando ela morreu.
///
/// TERM primeiro, espera até `timeout`, e KILL no que sobrou: quem ignora SIGTERM
/// não decide continuar de pé — a pessoa mandou parar. Devolve `true` quando a
/// árvore foi sinalizada como grupo; `false` quando não deu (processo que não é
/// líder de grupo, ou plataforma sem grupos), e aí cabe ao chamador matar o filho
/// direto e não prometer mais do que isso.
#[cfg(unix)]
pub fn kill_tree(pid: u32, timeout: Duration) -> bool {
    let pid = pid as i32;
    if !is_group_leader(pid) {
        return false;
    }
    signal_group(pid, "TERM");
    let step = Duration::from_millis(50);
    let mut waited = Duration::ZERO;
    while group_alive(pid) && waited < timeout {
        std::thread::sleep(step);
        waited += step;
    }
    if group_alive(pid) {
        signal_group(pid, "KILL");
    }
    true
}

#[cfg(not(unix))]
pub fn kill_tree(_pid: u32, _timeout: Duration) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// A prova que interessa: o NETO morre junto. É exatamente o caso do `sh -c`
    /// do preview e do master/worker do nginx.
    #[test]
    #[cfg(unix)]
    fn derrubar_a_arvore_mata_o_neto_tambem() {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 60 & echo $!; wait")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        own_group(&mut command);
        let mut child = command.spawn().expect("spawn");

        // O PID do neto sai na primeira linha do shell.
        let mut saida = String::new();
        {
            use std::io::Read;
            let mut stdout = child.stdout.take().expect("stdout");
            let mut buffer = [0u8; 64];
            let lidos = stdout.read(&mut buffer).unwrap_or(0);
            saida.push_str(&String::from_utf8_lossy(&buffer[..lidos]));
        }
        let neto: i32 = saida.trim().parse().expect("pid do neto");

        assert!(kill_tree(child.id(), Duration::from_secs(3)));
        let _ = child.wait();

        let vivo = Command::new("kill")
            .args(["-s", "0", &neto.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(
            !vivo,
            "o neto continuou vivo: era exatamente assim que o `stop` mentia"
        );
    }
}
