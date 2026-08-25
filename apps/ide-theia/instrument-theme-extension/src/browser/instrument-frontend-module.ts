// Frontend Theia module for the sketch 001 "Instrumento" reskin.
//
// Two things ship here:
//   1) a workbench color theme (Theia/Monaco tokens) — see instrument-theme-contribution
//   2) app-wide chrome CSS (fonts, radii, control heights, status-bar pulse feel)
//
// The CSS is imported for its side effect; Theia's webpack build (style-loader +
// css-loader, with ttf handled as a webpack asset) bundles it into the frontend.
// The path climbs out of the compiled `lib/` back into `src/` so the raw CSS and
// the font files travel with it — the standard Theia extension styling pattern.

import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { InstrumentThemeContribution } from './instrument-theme-contribution';

import '../../src/browser/style/instrument.css';

export default new ContainerModule(bind => {
    bind(InstrumentThemeContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(InstrumentThemeContribution);
});
