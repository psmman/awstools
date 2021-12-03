/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TextDocument } from 'vscode-languageserver-textdocument'
import globals from '../extensionGlobals'

export interface LanguageModelCache<T> {
    get(document: TextDocument): T
    onDocumentRemoved(document: TextDocument): void
    dispose(): void
}

export function getLanguageModelCache<T>(
    maxEntries: number,
    cleanupIntervalTimeInSec: number,
    parse: (document: TextDocument) => T
): LanguageModelCache<T> {
    let languageModels: { [uri: string]: { version: number; languageId: string; cTime: number; languageModel: T } } = {}
    let nModels = 0

    let cleanupInterval: NodeJS.Timer | undefined
    if (cleanupIntervalTimeInSec > 0) {
        cleanupInterval = globals.clock.setInterval(() => {
            const cutoffTime = globals.clock.Date.now() - cleanupIntervalTimeInSec * 1000
            const uris = Object.keys(languageModels)
            for (const uri of uris) {
                const languageModelInfo = languageModels[uri]
                if (languageModelInfo.cTime < cutoffTime) {
                    delete languageModels[uri]
                    nModels--
                }
            }
        }, cleanupIntervalTimeInSec * 1000)
    }

    return {
        get(document: TextDocument): T {
            const version = document.version
            const languageId = document.languageId
            const languageModelInfo = languageModels[document.uri]
            if (
                languageModelInfo &&
                languageModelInfo.version === version &&
                languageModelInfo.languageId === languageId
            ) {
                languageModelInfo.cTime = globals.clock.Date.now()

                return languageModelInfo.languageModel
            }
            const languageModel = parse(document)
            languageModels[document.uri] = { languageModel, version, languageId, cTime: globals.clock.Date.now() }
            if (!languageModelInfo) {
                nModels++
            }

            if (nModels === maxEntries) {
                let oldestTime = Number.MAX_VALUE
                let oldestUri
                for (const uri of Object.keys(languageModels)) {
                    const languageModelDetails = languageModels[uri]
                    if (languageModelDetails.cTime < oldestTime) {
                        oldestUri = uri
                        oldestTime = languageModelDetails.cTime
                    }
                }
                if (oldestUri) {
                    delete languageModels[oldestUri]
                    nModels--
                }
            }

            return languageModel
        },
        onDocumentRemoved(document: TextDocument) {
            const uri = document.uri
            if (languageModels[uri]) {
                delete languageModels[uri]
                nModels--
            }
        },
        dispose() {
            if (typeof cleanupInterval !== 'undefined') {
                globals.clock.clearInterval(cleanupInterval)
                cleanupInterval = undefined
                languageModels = {}
                nModels = 0
            }
        },
    }
}
