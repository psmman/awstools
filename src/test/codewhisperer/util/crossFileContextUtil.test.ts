/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as assert from 'assert'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as semver from 'semver'
import { getRelevantCrossFiles } from '../../../codewhisperer/util/supplementalContext/crossFileContextUtil'
import { shuffleList, closeAllEditors, toFile, assertTabSize } from '../../testUtil'
import { makeTemporaryToolkitFolder } from '../../../shared/filesystemUtilities'
import { normalize } from '../../../shared/utilities/pathUtils'
import { getLogger } from '../../../shared/logger'

// TODO: make it a util function inside testUtil.ts
let tempFolder: string

async function openATextEditorWithText(fileText: string, fileName: string): Promise<vscode.TextEditor> {
    const completeFilePath = path.join(tempFolder, fileName)
    toFile(fileText, completeFilePath)

    const textDocument = await vscode.workspace.openTextDocument(completeFilePath)

    return await vscode.window.showTextDocument(textDocument, { preview: false })
}

describe('getRelevantFiles', async function () {
    before(async function () {
        this.timeout(600000)
    })

    beforeEach(async function () {
        tempFolder = await makeTemporaryToolkitFolder()
        getLogger().verbose('Created temp folder: ' + tempFolder)
        getLogger().error('Created temp folder: ' + tempFolder)
        getLogger().info('Created temp folder: ' + tempFolder)
    })

    afterEach(async function () {
        getLogger().debug('Deleting temp folder')
        try {
            await fs.remove(tempFolder)
        } catch (e) {
            getLogger().error('Error deleting temp folder: ' + tempFolder)
            getLogger().error(`${e}`)
        }

        getLogger().debug('Done deleting temp folder')
    })

    after(async function () {
        await closeAllEditors()
    })

    it('should return opened files in the current window and sorted ascendingly by file distance', async function () {
        const shouldRunTheTest = semver.valid(vscode.version) && semver.gte(vscode.version, '1.68.0')

        if (!shouldRunTheTest) {
            this.skip()
        }

        const targetFile = path.join('service', 'microService', 'CodeWhispererFileContextProvider.java')
        const fileWithDistance3 = path.join('service', 'CodewhispererRecommendationService.java')
        const fileWithDistance5 = path.join('util', 'CodeWhispererConstants.java')
        const fileWithDistance6 = path.join('ui', 'popup', 'CodeWhispererPopupManager.java')
        const fileWithDistance7 = path.join('ui', 'popup', 'components', 'CodeWhispererPopup.java')
        const fileWithDistance8 = path.join('ui', 'popup', 'components', 'actions', 'AcceptRecommendationAction.java')

        const expectedFilePaths = [
            fileWithDistance3,
            fileWithDistance5,
            fileWithDistance6,
            fileWithDistance7,
            fileWithDistance8,
        ]
        const shuffledFilePaths = shuffleList(expectedFilePaths)

        let cnt = 0
        for (const file of shuffledFilePaths) {
            await openATextEditorWithText(file, file)
            cnt++
            await assertTabSize(cnt)
        }

        const editor = await openATextEditorWithText(targetFile, targetFile)
        await assertTabSize(6)

        const actuals = await getRelevantCrossFiles(editor)
        actuals.forEach(actual => {
            getLogger().debug(`${actual}`)
        })

        assert.ok(actuals.length === 5)

        actuals.forEach((actual, index) => {
            // vscode API will return normalized file path, thus /C:/Users/.../ for windows
            // thus need to manually add '/' and normalize
            const expected =
                process.platform === 'win32'
                    ? '/' + normalize(path.join(tempFolder, expectedFilePaths[index]))
                    : normalize(path.join(tempFolder, expectedFilePaths[index]))

            getLogger().debug(`${expected}`)
            getLogger().error(`${expected}`)
            getLogger().verbose(`${expected}`)

            assert.strictEqual(actual, expected)
        })
    })
})
