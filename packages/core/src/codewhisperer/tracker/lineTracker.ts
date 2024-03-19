/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { isTextEditor } from '../../shared/utilities/editorUtilities'

export interface LineSelection {
    anchor: number
    active: number
}

export interface LinesChangeEvent {
    readonly editor: vscode.TextEditor | undefined
    readonly selections: LineSelection[] | undefined

    readonly reason: 'editor' | 'selection' | 'content'
}

export class LineTracker implements vscode.Disposable {
    private _onDidChangeActiveLines = new vscode.EventEmitter<LinesChangeEvent>()
    get onDidChangeActiveLines(): vscode.Event<LinesChangeEvent> {
        return this._onDidChangeActiveLines.event
    }

    private _editor: vscode.TextEditor | undefined
    protected _disposable: vscode.Disposable | undefined

    private _selections: LineSelection[] | undefined

    private _suspended: boolean = false
    get selections(): LineSelection[] | undefined {
        return this._selections
    }

    private _onReady: vscode.EventEmitter<void> = new vscode.EventEmitter<void>()
    get onReady(): vscode.Event<void> {
        return this._onReady.event
    }

    private _ready: boolean = false
    get isReady() {
        return this._ready
    }

    constructor() {
        this._disposable = vscode.Disposable.from(
            vscode.window.onDidChangeActiveTextEditor(async e => {
                await this.onActiveTextEditorChanged(undefined)
            }),
            vscode.window.onDidChangeTextEditorSelection(async e => {
                await this.onTextEditorSelectionChanged(e)
            }),
            vscode.workspace.onDidChangeTextDocument(this.onContentChanged, this)
        )

        queueMicrotask(() => this.onActiveTextEditorChanged(vscode.window.activeTextEditor))
    }

    dispose() {
        this._disposable?.dispose()
    }

    ready() {
        if (this._ready) throw new Error('Container is already ready')

        this._ready = true
        queueMicrotask(() => this._onReady.fire())
    }

    // @VisibleForTesting
    async onActiveTextEditorChanged(editor: vscode.TextEditor | undefined) {
        if (editor === this._editor) return

        this._editor = editor
        this._selections = toLineSelections(editor?.selections)
        if (this._selections && this._selections[0]) {
            const s = this._selections.map(item => item.active + 1)
            vscode.commands.executeCommand('setContext', 'codewhisperer.activeLine', s)
        }

        if (this._suspended) {
        } else {
            this.notifyLinesChanged('editor')
        }
    }

    // @VisibleForTesting
    async onTextEditorSelectionChanged(e: vscode.TextEditorSelectionChangeEvent) {
        // If this isn't for our cached editor and its not a real editor -- kick out
        if (this._editor !== e.textEditor && !isTextEditor(e.textEditor)) return

        const selections = toLineSelections(e.selections)
        if (this._editor === e.textEditor && this.includes(selections)) return

        this._editor = e.textEditor
        this._selections = selections
        if (this._selections && this._selections[0]) {
            const s = this._selections.map(item => item.active + 1)
            vscode.commands.executeCommand('setContext', 'codewhisperer.activeLine', s)
        }

        if (this._suspended) {
        } else {
            this.notifyLinesChanged('selection')
        }
    }

    // @VisibleForTesting
    async onContentChanged(e: vscode.TextDocumentChangeEvent) {
        if (e.document === vscode.window.activeTextEditor?.document && e.contentChanges.length > 0) {
            this._editor = vscode.window.activeTextEditor
            this._selections = toLineSelections(this._editor?.selections)

            if (this._suspended) {
            } else {
                this.notifyLinesChanged('content')
            }
        }
    }

    notifyLinesChanged(reason: 'editor' | 'selection' | 'content') {
        const e: LinesChangeEvent = { editor: this._editor, selections: this.selections, reason: reason }
        this._onDidChangeActiveLines.fire(e)
    }

    includes(selections: LineSelection[]): boolean
    includes(line: number, options?: { activeOnly: boolean }): boolean
    includes(lineOrSelections: number | LineSelection[], options?: { activeOnly: boolean }): boolean {
        if (typeof lineOrSelections !== 'number') {
            return isIncluded(lineOrSelections, this._selections)
        }

        if (this._selections == null || this._selections.length === 0) return false

        const line = lineOrSelections
        const activeOnly = options?.activeOnly ?? true

        for (const selection of this._selections) {
            if (
                line === selection.active ||
                (!activeOnly &&
                    ((selection.anchor >= line && line >= selection.active) ||
                        (selection.active >= line && line >= selection.anchor)))
            ) {
                return true
            }
        }
        return false
    }
}

function isIncluded(selections: LineSelection[] | undefined, within: LineSelection[] | undefined): boolean {
    if (selections == null && within == null) return true
    if (selections == null || within == null || selections.length !== within.length) return false

    return selections.every((s, i) => {
        const match = within[i]
        return s.active === match.active && s.anchor === match.anchor
    })
}

function toLineSelections(selections: readonly vscode.Selection[]): LineSelection[]
function toLineSelections(selections: readonly vscode.Selection[] | undefined): LineSelection[] | undefined
function toLineSelections(selections: readonly vscode.Selection[] | undefined) {
    return selections?.map(s => ({ active: s.active.line, anchor: s.anchor.line }))
}
