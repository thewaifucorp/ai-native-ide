// Frontend trigger: a command palette entry that exercises the full round trip
// frontend -> Theia backend -> Rust ide-diff engine -> back, and shows the real
// engine output in a Theia message (full detail in the DevTools console).

import { Command, CommandContribution, CommandRegistry, MessageService } from '@theia/core';
import { inject, injectable } from '@theia/core/shared/inversify';
import { EngineService, Hunk } from '../common/engine-protocol';

export const ENGINE_DIFF_DEMO: Command = {
    id: 'engine.diff.demo',
    category: 'Engine',
    label: 'Diff Demo (Rust ide-diff engine)'
};

const SAMPLE_ORIGINAL = ['fn main() {', '    println!("hello");', '    let x = 1;', '}', ''].join('\n');

const SAMPLE_PROPOSED = [
    'fn main() {',
    '    println!("hello, world");',
    '    let x = 2;',
    '    let y = 3;',
    '}',
    ''
].join('\n');

@injectable()
export class EngineCommandContribution implements CommandContribution {
    @inject(EngineService) protected readonly engine!: EngineService;
    @inject(MessageService) protected readonly messages!: MessageService;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ENGINE_DIFF_DEMO, {
            execute: () => this.runDemo()
        });
    }

    protected async runDemo(): Promise<void> {
        try {
            const health = await this.engine.ping();
            const hunks = await this.engine.diff(SAMPLE_ORIGINAL, SAMPLE_PROPOSED);
            const selected = hunks.length > 0 ? [hunks[0].id] : [];
            const merged = await this.engine.mergeSelected(SAMPLE_ORIGINAL, SAMPLE_PROPOSED, selected);

            // eslint-disable-next-line no-console
            console.log('[engine-diff-demo] hunks =', JSON.stringify(hunks, undefined, 2));
            // eslint-disable-next-line no-console
            console.log('[engine-diff-demo] merged (accept only hunk #0):\n' + merged);

            const summary = this.describe(hunks);
            const mergedLines = merged.split('\n').filter(line => line.length > 0).length;
            this.messages.info(
                `Rust engine '${health.engine}' round-trip OK. ` +
                `${hunks.length} hunk(s): ${summary}. ` +
                `Accepting only hunk #0 -> ${mergedLines} non-empty line(s). ` +
                'Full hunks + merged text in the DevTools console.',
                'OK'
            );
        } catch (err) {
            this.messages.error(
                `Engine round-trip failed: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    protected describe(hunks: Hunk[]): string {
        return hunks
            .map(hunk => {
                const added = hunk.lines.filter(line => line.tag === 'added').length;
                const removed = hunk.lines.filter(line => line.tag === 'removed').length;
                return `#${hunk.id}(+${added}/-${removed})`;
            })
            .join(', ');
    }
}
