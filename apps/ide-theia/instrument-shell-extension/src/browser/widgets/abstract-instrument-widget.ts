// Common base for the six sketch-001 region widgets. Wires the shared store to
// Theia's widget update cycle: any store change re-renders every mounted region.

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { InstrumentStore } from '../instrument-store';

@injectable()
export abstract class AbstractInstrumentWidget extends ReactWidget {
    @inject(InstrumentStore) protected readonly store!: InstrumentStore;

    @postConstruct()
    protected init(): void {
        this.addClass('iws');
        this.configure();
        this.toDispose.push(this.store.onDidChange(() => this.update()));
        this.update();
    }

    /** Set id/title/extra classes for the concrete region. */
    protected abstract configure(): void;
}
