/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path'
import * as vscode from 'vscode'
import { ExtContext } from '../shared/extensions'
import { ExtensionUtilities, isCloud9 } from '../shared/extensionUtilities'
import { Protocol, registerWebviewServer } from './server'
import { getIdeProperties } from '../shared/extensionUtilities'

interface WebviewParams {
    /**
     * The entry-point into the webview.
     */
    webviewJs: string

    /**
     * Styling sheets to use, applied to the entire webview.
     *
     * If none are provided, `base.css` is used by default.
     */
    cssFiles?: string[]

    /**
     * Additional JS files to loaded in.
     */
    libFiles?: string[]
}

interface WebviewPanelParams extends WebviewParams {
    /**
     * ID of the webview which should be globally unique per view.
     */
    id: string

    /**
     * Title of the webview panel. This is shown in the editor tab.
     */
    title: string

    /**
     * Preserves the webview when not focused by the user.
     *
     * This has a performance penalty and should be avoided.
     */
    retainContextWhenHidden?: boolean

    /**
     * View column to initally show the view in. Defaults to split view.
     */
    viewColumn?: vscode.ViewColumn
}

interface WebviewViewParams extends WebviewParams {
    /**
     * ID of the webview which must be the same as the one used in `package.json`.
     */
    id: string

    /**
     * Title of the view. Defaults to the title set in `package.json` is not provided.
     */
    title?: string

    /**
     * Optional 'description' text applied to the title.
     */
    description?: string
}

/**
 * A compiled webview created from {@link compileVueWebview}.
 */
export interface VueWebviewPanel<T extends VueWebview = VueWebview> {
    /**
     * Shows the webview with the given parameters.
     *
     * @returns A Promise that is resolved once the view is closed.
     */
    show(params?: Partial<Omit<WebviewPanelParams, 'id' | 'webviewJs'>>): Promise<vscode.WebviewPanel>

    clear(): Promise<boolean>

    readonly server: T
}

export interface VueWebviewView<T extends VueWebview = VueWebview> {
    register(params?: Partial<Omit<WebviewViewParams, 'id' | 'webviewJs'>>): vscode.Disposable

    readonly server: T
}

/**
 * Generates an anonymous class whose instances have the interface {@link VueWebviewPanel}.
 *
 * You can give this class a name by extending off of it:
 * ```ts
 * export class MyWebview extends compileVueWebview(...) {}
 * const view = new MyWebview()
 * view.show()
 * ```
 *
 * @param params Required parameters are defined by {@link WebviewPanelParams}, optional parameters are defined by {@link WebviewCompileOptions}
 *
 * @returns An anonymous class that can instantiate instances of {@link VueWebviewPanel}.
 */
export abstract class VueWebview {
    public abstract readonly id: string
    public abstract readonly source: string
    public readonly title?: string

    private readonly protocol: Protocol
    private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>()
    public readonly onDidDispose = this.onDidDisposeEmitter.event

    private context?: ExtContext

    public constructor() {
        const commands: Record<string, (...args: any[]) => unknown> = {}
        const proto = Object.getPrototypeOf(this)

        // This only checks the immediate parent class; it should be checking the entire chain down to the current class
        for (const prop of Object.getOwnPropertyNames(proto)) {
            const val = proto[prop]
            if (typeof val === 'function') {
                commands[prop] = val.bind(this)
            }
        }

        this.protocol = commands
    }

    public getCompanyName(): string {
        return getIdeProperties().company
    }

    protected dispose(): void {
        this.onDidDisposeEmitter.fire()
    }

    protected getContext(): ExtContext {
        if (!this.context) {
            throw new Error('Webview was not initialized with "ExtContext')
        }

        return this.context
    }

    public static compilePanel<T extends new (...args: any[]) => U, U extends VueWebview>(
        target: T
    ): new (context: ExtContext, ...args: ConstructorParameters<T>) => VueWebviewPanel<U> {
        return class Panel {
            private readonly instance: U
            private panel?: vscode.WebviewPanel

            public constructor(protected readonly context: ExtContext, ...args: ConstructorParameters<T>) {
                this.instance = new target(...args)

                for (const [prop, val] of Object.entries(this.instance)) {
                    if (val instanceof vscode.EventEmitter) {
                        Object.assign(this.instance.protocol, { [prop]: val })
                    }
                }
            }

            public get server() {
                return this.instance
            }

            public async show(params: Omit<WebviewPanelParams, 'id' | 'webviewJs'>): Promise<vscode.WebviewPanel> {
                if (this.panel) {
                    this.panel.reveal(params.viewColumn, false)
                    return this.panel
                }

                const panel = createWebviewPanel({
                    id: this.instance.id,
                    webviewJs: this.instance.source,
                    context: this.context,
                    ...params,
                })
                const server = registerWebviewServer(panel.webview, this.instance.protocol)
                this.instance.onDidDispose(() => {
                    server.dispose()
                    this.panel?.dispose()
                    this.panel = undefined
                })

                return (this.panel = panel)
            }

            public async clear(): Promise<boolean> {
                return this.panel?.webview.postMessage({ command: '$clear' }) ?? false
            }
        }
    }

    public static compileView<T extends new (...args: any[]) => U, U extends VueWebview>(
        target: T
    ): new (context: ExtContext, ...args: ConstructorParameters<T>) => VueWebviewView<U> {
        return class View {
            private readonly instance: U
            private view?: vscode.WebviewView

            public constructor(protected readonly context: ExtContext, ...args: ConstructorParameters<T>) {
                this.instance = new target(...args)

                for (const [prop, val] of Object.entries(this.instance)) {
                    if (val instanceof vscode.EventEmitter) {
                        Object.assign(this.instance.protocol, { [prop]: val })
                    }
                }

                this.instance.context = this.context
            }

            public get server() {
                return this.instance
            }

            public register(params: Omit<WebviewViewParams, 'id' | 'webviewJs'>): vscode.Disposable {
                return vscode.window.registerWebviewViewProvider(this.instance.id, {
                    resolveWebviewView: async view => {
                        view.title = params.title ?? view.title
                        view.description = params.description ?? view.description
                        updateWebview(view.webview, {
                            ...params,
                            webviewJs: this.instance.source,
                            context: this.context,
                        })

                        if (!this.view) {
                            this.view = view

                            const server = registerWebviewServer(this.view.webview, this.instance.protocol)
                            this.view.onDidDispose(() => server.dispose())
                            this.view.onDidDispose(() => {
                                server.dispose()
                                this.view = undefined
                            })
                        }
                    },
                })
            }
        }
    }
}

type FilteredKeys<T> = { [P in keyof T]: unknown extends T[P] ? never : P }[keyof T]
type FilterUnknown<T> = Pick<T, FilteredKeys<T>>
type Commands<T extends VueWebview> = {
    [P in keyof T]: T[P] extends (...args: any[]) => any ? T[P] : unknown
}
type Events<T extends VueWebview> = {
    [P in keyof T]: T[P] extends vscode.EventEmitter<any> ? T[P] : unknown
}
export type ClassToProtocol<T extends VueWebview> = FilterUnknown<Commands<T> & Events<T>>

/**
 * This is the {@link vscode.WebviewView} version of {@link compileVueWebview}.
 *
 * The biggest difference is that only a single view per-id can exist at a time, while multiple panels can exist per-id.
 * Views also cannot register handlers for `submit`; any `submit` commands made by the fronend are ignored.
 *
 * @param params Required parameters are defined by {@link WebviewViewParams}, optional parameters are defined by {@link WebviewCompileOptions}
 *
 * @returns An anonymous class that can instantiate instances of {@link VueWebviewView}.
 */

/**
 * Creates a brand new webview panel, setting some basic initial parameters and updating the webview.
 */
function createWebviewPanel(params: WebviewPanelParams & { context: ExtContext }): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        params.id,
        params.title,
        {
            viewColumn: isCloud9() ? vscode.ViewColumn.Two : params.viewColumn ?? vscode.ViewColumn.Beside,
        },
        {
            // The redundancy here is to correct a bug with Cloud9's Webview implementation
            // We need to assign certain things on instantiation, otherwise they'll never be applied to the view
            enableScripts: true,
            enableCommandUris: true,
            retainContextWhenHidden: isCloud9() || params.retainContextWhenHidden,
        }
    )
    updateWebview(panel.webview, params)

    return panel
}

/**
 * Mutates a webview, applying various options and a static HTML page to bootstrap the Vue code.
 */
function updateWebview(webview: vscode.Webview, params: WebviewParams & { context: ExtContext }): vscode.Webview {
    const context = params.context.extensionContext
    const libsPath: string = path.join(context.extensionPath, 'dist', 'libs')
    const jsPath: string = path.join(context.extensionPath, 'media', 'js')
    const cssPath: string = path.join(context.extensionPath, 'media', 'css')
    const webviewPath: string = path.join(context.extensionPath, 'dist')
    const resourcesPath: string = path.join(context.extensionPath, 'resources')

    webview.options = {
        enableScripts: true,
        enableCommandUris: true,
        localResourceRoots: [
            vscode.Uri.file(libsPath),
            vscode.Uri.file(jsPath),
            vscode.Uri.file(cssPath),
            vscode.Uri.file(webviewPath),
            vscode.Uri.file(resourcesPath),
        ],
    }

    const loadLibs = ExtensionUtilities.getFilesAsVsCodeResources(
        libsPath,
        ['vue.min.js', ...(params.libFiles ?? [])],
        webview
    ).concat(ExtensionUtilities.getFilesAsVsCodeResources(jsPath, ['loadVsCodeApi.js'], webview))

    const cssFiles = params.cssFiles ?? [isCloud9() ? 'base-cloud9.css' : 'base.css']
    const loadCss = ExtensionUtilities.getFilesAsVsCodeResources(cssPath, [...cssFiles], webview)

    let scripts: string = ''
    let stylesheets: string = ''

    loadLibs.forEach(element => {
        scripts = scripts.concat(`<script src="${element}"></script>\n\n`)
    })

    loadCss.forEach(element => {
        stylesheets = stylesheets.concat(`<link rel="stylesheet" href="${element}">\n\n`)
    })

    const mainScript = webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, params.webviewJs)))

    webview.html = resolveWebviewHtml({
        scripts,
        stylesheets,
        main: mainScript,
        webviewJs: params.webviewJs,
        cspSource: updateCspSource(webview.cspSource),
    })

    return webview
}

/**
 * Resolves the webview HTML based off whether we're running from a development server or bundled extension.
 */
function resolveWebviewHtml(params: {
    scripts: string
    stylesheets: string
    cspSource: string
    webviewJs: string
    main: vscode.Uri
}): string {
    const resolvedParams = { ...params, connectSource: `'none'` }
    const LOCAL_SERVER = process.env.WEBPACK_DEVELOPER_SERVER

    if (LOCAL_SERVER) {
        const local = vscode.Uri.parse(LOCAL_SERVER)
        resolvedParams.cspSource = `${params.cspSource} ${local.toString()}`
        resolvedParams.main = local.with({ path: `/${params.webviewJs}` })
        resolvedParams.connectSource = `'self' ws:`
    }

    return `<html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">

        <meta
            http-equiv="Content-Security-Policy"
            content=
                "default-src 'none';
                connect-src ${resolvedParams.connectSource};
                img-src ${resolvedParams.cspSource} https: data:;
                script-src ${resolvedParams.cspSource};
                style-src ${resolvedParams.cspSource} 'unsafe-inline';
                font-src 'self' data:;"
        >
    </head>
    <body>
        <div id="vue-app"></div>
        <!-- Dependencies -->
        ${resolvedParams.scripts}
        ${resolvedParams.stylesheets}
        <!-- Main -->
        <script src="${resolvedParams.main}"></script>
    </body>
</html>`
}

/**
 * Updates the CSP source for webviews with an allowed source for AWS endpoints when running in
 * Cloud9 environments. Possible this can be further scoped to specific C9 CDNs or removed entirely
 * if C9 injects this.
 */
export function updateCspSource(baseSource: string) {
    return isCloud9() ? `https://*.amazonaws.com ${baseSource}` : baseSource
}
