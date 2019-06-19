/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as _ from 'lodash'
import * as path from 'path'
import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import { ScriptResource } from '../lambda/models/scriptResource'
import { ext } from '../shared/extensionGlobals'
import { readFileAsString } from './filesystemUtilities'

const localize = nls.loadMessageBundle()

export class ExtensionUtilities {
    public static getLibrariesForHtml(names: string[]): ScriptResource[] {
        const basePath = path.join(ext.context.extensionPath, 'media', 'libs')

        return this.resolveResourceURIs(basePath, names)
    }

    public static getScriptsForHtml(names: string[]): ScriptResource[] {
        const basePath = path.join(ext.context.extensionPath, 'media', 'js')

        return this.resolveResourceURIs(basePath, names)
    }

    public static getNonce(): string {
        let text = ''
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length))
        }

        return text
    }

    private static resolveResourceURIs(basePath: string, names: string[]): ScriptResource[] {
        const scripts: ScriptResource[] = []
        _.forEach(names, (scriptName) => {
            const scriptPathOnDisk = vscode.Uri.file(path.join(basePath, scriptName))
            const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' })
            const nonce = ExtensionUtilities.getNonce()
            scripts.push({ nonce: nonce, uri: scriptUri })
        })

        return scripts
    }
}

/**
 * A utility function that takes a possibly null value and applies
 * the given function to it, returning the result of the function or null
 *
 * example usage:
 *
 * function blah(value?: SomeObject) {
 *  nullSafeGet(value, x => x.propertyOfSomeObject)
 * }
 *
 * @param obj the object to attempt the get function on
 * @param getFn the function to use to determine the mapping value
 */
export function safeGet<O, T>(obj: O | undefined, getFn: (x: O) => T): T | undefined {
    if (obj) {
        try {
            return getFn(obj)
        } catch (error) {
            // ignore
        }
    }

    return undefined
}

/**
 * Helper function to create a webview containing the welcome page
 * Returns an unfocused vscode.WebviewPanel if the welcome page is renderable.
 * Returns void if the welcomePage.html file is unrenderable
 *
 * @param context VS Code Extension Context
 * @param page Page to load (use for testing); default: `welcomePage.html`
 */
export async function createWelcomeWebview(
    context: vscode.ExtensionContext,
    page: string = 'welcomePage.html'
): Promise<vscode.WebviewPanel | void> {
    let html: string | undefined
    try {
        html = convertExtensionRootTokensToPath(
            await readFileAsString(path.join(context.extensionPath, page)),
            context.extensionPath
        )
        if (!html) {
            throw new Error()
        }
    } catch {
        return
    }

    // create hidden webview, leave it up to the caller to show
    const view = vscode.window.createWebviewPanel(
        'html',
        localize('AWS.command.welcome.title', 'AWS Toolkit - Welcome'),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }
    )
    view.webview.html = html

    return view
}

/**
 * Utility function to search for tokens in a string and convert them to relative paths parseable by VS Code
 * Useful for converting HTML images to webview-usable images
 *
 * @param text Text to scan
 * @param basePath Extension path (from extension context)
 */
function convertExtensionRootTokensToPath(
    text: string,
    basePath: string
): string {
    return text.replace(/!!EXTENSIONROOT!!/g, `vscode-resource:${basePath}`)
}
