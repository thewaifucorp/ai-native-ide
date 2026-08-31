// Registers the sketch 001 "Instrumento" dark color theme with Theia's Monaco
// theming service. Registration happens as early as the frontend starts, so the
// theme is present when ThemeService validates the configured `workbench.colorTheme`
// (set to `instrument-dark` by default in the app's frontend config).

import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MonacoThemingService } from '@theia/monaco/lib/browser/monaco-theming-service';
import { instrumentColorTheme } from './instrument-color-theme';

export const INSTRUMENT_THEME_ID = 'instrument-dark';

@injectable()
export class InstrumentThemeContribution implements FrontendApplicationContribution {
    @inject(MonacoThemingService)
    protected readonly monacoThemingService!: MonacoThemingService;

    // Runs before the shell is attached; registers the theme into ThemeService.
    initialize(): void {
        this.monacoThemingService.registerParsedTheme({
            id: INSTRUMENT_THEME_ID,
            label: 'Instrument · 001',
            description: 'Dark instrument reskin from sketch 001.',
            uiTheme: 'vs-dark',
            json: instrumentColorTheme as unknown as Record<string, unknown>
        });
    }
}
