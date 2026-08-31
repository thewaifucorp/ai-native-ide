/**
 * Terminal output is deliberately rendered as text inside a `pre`, never as
 * HTML. The host may stream arbitrary bytes from a child process, so allowing
 * that data through a markup sink would turn terminal output into a renderer
 * capability escalation.
 */
export function TerminalSurface({
  lines,
  running,
  onSubmit,
  onCancel,
}: {
  lines: readonly string[];
  running: boolean;
  onSubmit: (input: string) => void;
  onCancel: () => void;
}) {
  return (
    <section className="terminal-surface" aria-label="Terminal do workspace">
      <header>
        <span className="eyebrow">TERMINAL</span>
        <strong>{running ? "sessão ativa" : "sessão encerrada"}</strong>
        <button
          className="text-button"
          disabled={!running}
          onClick={onCancel}
          type="button"
        >
          Encerrar <span>→</span>
        </button>
      </header>
      <pre aria-live="polite" aria-label="Saída bruta do terminal">
        {lines.length ? lines.join("\n") : "Aguardando saída do host…"}
      </pre>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const input = new FormData(form).get("terminal-input");
          if (typeof input !== "string" || !input.trim()) return;
          onSubmit(`${input}\n`);
          form.reset();
        }}
      >
        <label htmlFor="terminal-input">Enviar para esta sessão</label>
        <div>
          <input
            autoComplete="off"
            disabled={!running}
            id="terminal-input"
            name="terminal-input"
            spellCheck={false}
          />
          <button disabled={!running} type="submit">
            Enviar
          </button>
        </div>
      </form>
    </section>
  );
}
