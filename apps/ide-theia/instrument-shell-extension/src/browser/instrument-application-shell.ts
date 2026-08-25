// REAL ApplicationShell integration for the sketch-001 "Instrumento" layout.
//
// This replaces the previous overlay hack (six ReactWidgets painted over a
// CSS-hidden native shell). Instead we subclass Theia's ApplicationShell and
// override `createLayout()` — the ONE supported seam for reshaping the workbench
// box/split geometry — to weave the 001 bespoke chrome into the SAME Lumino
// layout tree that hosts the native areas:
//
//   top-to-bottom BoxLayout
//   ├── crumb        (44px bespoke titlebar — fixed row)
//   ├── topPanel     (native menu bar — hidden unless menus shown)
//   ├── center       left-to-right BoxLayout
//   │   ├── rail     (56px bespoke project rail — fixed column)
//   │   └── sideAreas horizontal SplitPanel (verbatim native geometry):
//   │       ├── leftPanelHandler.container   → REAL @theia/navigator file explorer
//   │       ├── main + bottom vertical split → REAL Monaco editors (+ Overview widget)
//   │       └── rightPanelHandler.container  → bespoke Context dock
//   ├── pulse        (42px bespoke strand strip — fixed row)
//   └── statusBar    (native status bar)
//
// `createLayout()` is invoked from `initializeShell()`, which Theia calls from
// the `@postConstruct init()` — i.e. AFTER Inversify property injection — so the
// rail/crumb/pulse widgets injected below are already resolved when we read them.
// Nothing is hidden; every native area is genuinely mounted and used.

import { injectable, inject } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { TheiaSplitPanel } from '@theia/core/lib/browser/shell/theia-split-panel';
import { BoxPanel, Layout } from '@theia/core/shared/@lumino/widgets';
import { RailWidget } from './widgets/rail-widget';
import { CrumbWidget } from './widgets/crumb-widget';
import { PulseWidget } from './widgets/pulse-widget';
import { NavModesWidget } from './widgets/nav-modes-widget';

@injectable()
export class InstrumentApplicationShell extends ApplicationShell {

    @inject(RailWidget) protected readonly railWidget!: RailWidget;
    @inject(CrumbWidget) protected readonly crumbWidget!: CrumbWidget;
    @inject(PulseWidget) protected readonly pulseWidget!: PulseWidget;
    @inject(NavModesWidget) protected readonly navModesWidget!: NavModesWidget;

    protected override createLayout(): Layout {
        // The rail/crumb/pulse widgets already carry their `iws-*-host` classes
        // (set in each widget's configure()); the ported 001 CSS turns those into
        // fixed-size in-flow slots, and the Lumino BoxLayout reads their fixed
        // size from the CSS min/max-width|height on those same classes.

        // main (editors) stacked over the native bottom panel — verbatim native geometry.
        const bottomSplitLayout = this.createSplitLayout(
            [this.mainPanel, this.bottomPanel],
            [1, 0],
            { orientation: 'vertical', spacing: 0 }
        );
        const panelForBottomArea = new TheiaSplitPanel({ layout: bottomSplitLayout });
        panelForBottomArea.id = 'theia-bottom-split-panel';

        // The left column = a bespoke "modes" row (NavModesWidget, ~40px, replacing
        // stock Theia's vertical activity bar) stacked ABOVE the REAL @theia
        // left-panel container. The modes buttons reveal the various view-containers
        // (explorer / search / scm / extensions / bespoke Produto) INTO that same
        // native panel. Because the container's parent is now a BoxPanel (not a
        // SplitPanel), SidePanelHandler skips its split-relative resize — exactly
        // what we want for a pinned 240px column.
        const leftColumn = new BoxPanel({ direction: 'top-to-bottom', spacing: 0 });
        leftColumn.id = 'iws-left-column';
        BoxPanel.setStretch(this.navModesWidget, 0);
        BoxPanel.setStretch(this.leftPanelHandler.container, 1);
        leftColumn.addWidget(this.navModesWidget);
        leftColumn.addWidget(this.leftPanelHandler.container);

        // left column | (main/bottom) | right side panel — verbatim native geometry.
        const leftRightSplitLayout = this.createSplitLayout(
            [leftColumn, panelForBottomArea, this.rightPanelHandler.container],
            [0, 1, 0],
            { orientation: 'horizontal', spacing: 0 }
        );
        const panelForSideAreas = new TheiaSplitPanel({ layout: leftRightSplitLayout });
        panelForSideAreas.id = 'theia-main-content-panel';

        // Prepend the bespoke 56px rail as a fixed far-left column (BoxLayout, so no
        // draggable split handle appears between rail and the workbench).
        const centerPanel = new BoxPanel({ direction: 'left-to-right', spacing: 0 });
        centerPanel.id = 'iws-center';
        BoxPanel.setStretch(this.railWidget, 0);
        BoxPanel.setStretch(panelForSideAreas, 1);
        centerPanel.addWidget(this.railWidget);
        centerPanel.addWidget(panelForSideAreas);

        // The outer vertical stack: crumb, native menu, the rail+areas center, the
        // pulse strand strip, and the native status bar.
        return this.createBoxLayout(
            [this.crumbWidget, this.topPanel, centerPanel, this.pulseWidget, this.statusBar],
            [0, 0, 1, 0, 0],
            { direction: 'top-to-bottom', spacing: 0 }
        );
    }
}
