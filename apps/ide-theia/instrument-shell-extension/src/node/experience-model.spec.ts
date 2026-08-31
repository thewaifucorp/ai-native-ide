import { expect } from 'chai';
import { deriveProjectSessions } from '../common/experience-model';

describe('experience model — project sessions are derived', () => {
    it('keeps preview, sharing and delivery locked without project facts', () => {
        const states = deriveProjectSessions({});
        expect(states.map(state => state.availability)).to.deep.equal([
            'locked', 'locked', 'locked'
        ]);
        expect(states.every(state => state.reason.length > 0)).to.equal(true);
    });

    it('unlocks preview from a declaration and sharing only while it is active', () => {
        const ready = deriveProjectSessions({
            preview: {
                declared: { command: 'npm run dev', url: 'http://localhost:3000' },
                running: false,
                stopped: false,
                failures: []
            }
        });
        expect(ready[0].availability).to.equal('ready');
        expect(ready[1].availability).to.equal('locked');

        const active = deriveProjectSessions({
            preview: {
                declared: { command: 'npm run dev', url: 'http://localhost:3000' },
                running: true,
                stopped: false,
                failures: [],
                state: { health: 'healthy', changed_at_ms: 1 }
            }
        });
        expect(active[0].availability).to.equal('active');
        expect(active[1].availability).to.equal('ready');
    });

    it('marks a broken preview as failed instead of locking it again', () => {
        const [preview] = deriveProjectSessions({
            preview: {
                declared: { command: 'npm run dev' },
                running: false,
                stopped: false,
                failures: [],
                state: { health: 'broken', changed_at_ms: 1, detail: 'porta ocupada' }
            }
        });
        expect(preview.availability).to.equal('failed');
        expect(preview.reason).to.equal('porta ocupada');
    });

    it('unlocks delivery when the project lifecycle exists', () => {
        const states = deriveProjectSessions({
            lifecycle: {
                nextVersion: '0.0.1', history: [], exports: [],
                logPath: '.product/releases.json', exportsPath: '.product/exports'
            }
        });
        expect(states[2].availability).to.equal('ready');
    });
});
