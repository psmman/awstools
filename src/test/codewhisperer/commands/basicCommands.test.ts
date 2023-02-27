/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as assert from 'assert'
import { beforeEach } from 'mocha'
import * as sinon from 'sinon'
import { resetCodeWhispererGlobalVariables } from '../testUtil'
import { assertTelemetryCurried } from '../../testUtil'
import * as CodeWhispererConstants from '../../../codewhisperer/models/constants'
import { toggleCodeSuggestions, get, set, showSecurityScan } from '../../../codewhisperer/commands/basicCommands'
import { FakeMemento, FakeExtensionContext } from '../../fakeExtensionContext'
import { testCommand } from '../../shared/vscode/testUtils'
import { Command } from '../../../shared/vscode/commands2'
import { SecurityPanelViewProvider } from '../../../codewhisperer/views/securityPanelViewProvider'
import { join } from 'path'
import { getTestWorkspaceFolder } from '../../../integrationTest/integrationTestsUtilities'
import { DefaultCodeWhispererClient } from '../../../codewhisperer/client/codewhisperer'
import { stub } from '../../utilities/stubber'
import { AuthUtil } from '../../../codewhisperer/util/authUtil'
import { getTestWindow } from '../../shared/vscode/window'
// import { Auth } from '../../../credentials/auth'
// import { SecondaryAuth } from '../../../credentials/secondaryAuth'
// import { startSecurityScanWithProgress } from '../../../codewhisperer/commands/startSecurityScan'

describe('CodeWhisperer-basicCommands', function () {
    let targetCommand: Command<any> & vscode.Disposable

    beforeEach(function () {
        resetCodeWhispererGlobalVariables()
    })

    afterEach(function () {
        targetCommand?.dispose()
        sinon.restore()
    })

    it('test get()', async function () {
        const fakeMemeto = new FakeMemento()
        fakeMemeto.update(CodeWhispererConstants.autoTriggerEnabledKey, true)

        let res = get(CodeWhispererConstants.autoTriggerEnabledKey, fakeMemeto)
        assert.strictEqual(res, true)

        fakeMemeto.update(CodeWhispererConstants.autoTriggerEnabledKey, undefined)
        res = get(CodeWhispererConstants.autoTriggerEnabledKey, fakeMemeto)
        assert.strictEqual(res, undefined)

        fakeMemeto.update(CodeWhispererConstants.autoTriggerEnabledKey, false)
        res = get(CodeWhispererConstants.autoTriggerEnabledKey, fakeMemeto)
        assert.strictEqual(res, false)
    })

    it('test set()', async function () {
        const fakeMemeto = new FakeMemento()
        set(CodeWhispererConstants.autoTriggerEnabledKey, true, fakeMemeto)
        assert.strictEqual(fakeMemeto.get(CodeWhispererConstants.autoTriggerEnabledKey), true)

        set(CodeWhispererConstants.autoTriggerEnabledKey, false, fakeMemeto)
        assert.strictEqual(fakeMemeto.get(CodeWhispererConstants.autoTriggerEnabledKey), false)
    })

    describe('toggleCodeSuggestion', function () {
        beforeEach(function () {
            resetCodeWhispererGlobalVariables()
        })

        it('should emit aws_modifySetting event on user toggling autoSuggestion - deactivate', async function () {
            const fakeMemeto = new FakeMemento()
            targetCommand = testCommand(toggleCodeSuggestions, fakeMemeto)
            fakeMemeto.update(CodeWhispererConstants.autoTriggerEnabledKey, true)
            assert.strictEqual(fakeMemeto.get(CodeWhispererConstants.autoTriggerEnabledKey), true)

            await targetCommand.execute()
            const res = fakeMemeto.get(CodeWhispererConstants.autoTriggerEnabledKey)
            assert.strictEqual(res, false)
            assertTelemetryCurried('aws_modifySetting')({
                settingId: CodeWhispererConstants.autoSuggestionConfig.settingId,
                settingState: CodeWhispererConstants.autoSuggestionConfig.deactivated,
            })
        })

        it('should emit aws_modifySetting event on user toggling autoSuggestion -- activate', async function () {
            const fakeMemeto = new FakeMemento()
            targetCommand = testCommand(toggleCodeSuggestions, fakeMemeto)

            assert.strictEqual(fakeMemeto.get(CodeWhispererConstants.autoTriggerEnabledKey), undefined)
            await targetCommand.execute()
            const res = fakeMemeto.get(CodeWhispererConstants.autoTriggerEnabledKey)
            assert.strictEqual(res, true)
            assertTelemetryCurried('aws_modifySetting')({
                settingId: CodeWhispererConstants.autoSuggestionConfig.settingId,
                settingState: CodeWhispererConstants.autoSuggestionConfig.activated,
            })
        })
    })

    describe('showSecurityScan', function () {
        beforeEach(function () {
            resetCodeWhispererGlobalVariables()

        })

        afterEach(function () {
            targetCommand?.dispose()
            sinon.restore()
        })

        it('prompts user to reauthenticate if connection is expired', async function () {
            const extensionContext = await FakeExtensionContext.create()
            const mockSecurityPanelViewProvider = new SecurityPanelViewProvider(extensionContext)
            const mockClient = stub(DefaultCodeWhispererClient) 
            const extContext = await FakeExtensionContext.getFakeExtContext()
            targetCommand = testCommand(showSecurityScan, extContext, mockSecurityPanelViewProvider, mockClient)
            sinon.stub(AuthUtil.instance, 'isConnectionExpired').returns(true)
            const spy = sinon.stub(AuthUtil.instance, 'showReauthenticatePrompt').resolves()
            // console.log("AuthUtil.instance.isConnectionExpired()", AuthUtil.instance.isConnectionExpired())

            await targetCommand.execute()
            
            assert.ok(spy.called)
        })

        it('starts security scan if user is connected and has an active editor', async function () {
            const extensionContext = await FakeExtensionContext.create()
            const mockSecurityPanelViewProvider = new SecurityPanelViewProvider(extensionContext)
            const mockClient = stub(DefaultCodeWhispererClient) 
            const extContext = await FakeExtensionContext.getFakeExtContext()
            const workspaceFolder = getTestWorkspaceFolder()
            const appRoot = join(workspaceFolder, 'python3.7-plain-sam-app')
            const appCodePath = join(appRoot, 'hello_world', 'app.py')
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(appCodePath))
            const editor = await vscode.window.showTextDocument(doc) 
            
            targetCommand = testCommand(showSecurityScan, extContext, mockSecurityPanelViewProvider, mockClient)
            
            sinon.stub(AuthUtil.instance, 'isConnectionExpired').returns(false)
            sinon.stub(vscode.window, 'activeTextEditor').resolves(editor)
           
            await targetCommand.execute()
     
            assert.strictEqual(getTestWindow().shownMessages[0].message, "Running security scan...")
        })

        it('shows information message if there is no active text editor', async function () {
            const extensionContext = await FakeExtensionContext.create()
            const mockSecurityPanelViewProvider = new SecurityPanelViewProvider(extensionContext)
            const mockClient = stub(DefaultCodeWhispererClient) 
            const extContext = await FakeExtensionContext.getFakeExtContext()
            
            targetCommand = testCommand(showSecurityScan, extContext, mockSecurityPanelViewProvider, mockClient)
            
            sinon.stub(AuthUtil.instance, 'isConnectionExpired').returns(false)
            assert.ok(vscode.window.activeTextEditor === undefined)

            await targetCommand.execute()
            
            assert.strictEqual(getTestWindow().shownMessages[0].message, "Open a valid file to scan.")
        })




        // it('if codeScanState is not running and there is no active text editor, should show information message', async function () {
        //     const extensionContext = await FakeExtensionContext.create()
        //     const mockSecurityPanelViewProvider = new SecurityPanelViewProvider(extensionContext)
        //     sinon.stub(AuthUtil.instance, 'isConnectionExpired').resolves(false)
        //     const workspaceFolder = getTestWorkspaceFolder()
        //     const appRoot = join(workspaceFolder, 'go1-plain-sam-app')
        //     const appCodePath = join(appRoot, 'hello-world', 'main.go')
             
        //     const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(appCodePath))
        //     const editor = await vscode.window.showTextDocument(doc) 
        //     // console.log("editor in test ", editor)
        //     const mockClient = stub(DefaultCodeWhispererClient) 
        //     const extContext = await FakeExtensionContext.getFakeExtContext()
        //     targetCommand = testCommand(showSecurityScan, extContext, mockSecurityPanelViewProvider, mockClient)
        //     sinon.stub(vscode.window, 'activeTextEditor').resolves()
        //     // const authUtil = stub(AuthUtil)
        //     // authUtil.isConnectionExpired.resolves(true)
           
        //     // const spy = sinon.stub(AuthUtil.instance, 'isConnectionExpired').resolves(true)
        //     // sinon.stub(AuthUtil.instance, 'showReauthenticatePrompt').resolves(true)
        //     // const spy = sinon.stub(startSecurityScanWithProgress)
        //     await targetCommand.execute()
        //     assert.ok(true)
        //     // assert.ok(spy.called)
        // })

        // it('if codeScanState is not running and there is an active text editor, should show information message', async function () {
        //     const extensionContext = await FakeExtensionContext.create()
        //     const mockSecurityPanelViewProvider = new SecurityPanelViewProvider(extensionContext)
           
        //     const workspaceFolder = getTestWorkspaceFolder()
        //     const appRoot = join(workspaceFolder, 'go1-plain-sam-app')
        //     const appCodePath = join(appRoot, 'hello-world', 'main.go')
             
        //     const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(appCodePath))
        //     const editor = await vscode.window.showTextDocument(doc) 
        //     console.log(editor)
        //     const mockClient = stub(DefaultCodeWhispererClient) 
        //     const extContext = await FakeExtensionContext.getFakeExtContext()
        //     targetCommand = testCommand(showSecurityScan, extContext, mockSecurityPanelViewProvider, mockClient)
        //     sinon.stub(vscode.window, 'activeTextEditor').resolves()
        //     // const authUtil = stub(AuthUtil)
        //     // authUtil.isConnectionExpired.resolves(true)
        //     sinon.stub(AuthUtil.instance, 'isConnectionExpired').resolves(false)
        //     // const spy = sinon.stub(AuthUtil.instance, 'isConnectionExpired').resolves(true)
        //     // sinon.stub(AuthUtil.instance, 'showReauthenticatePrompt').resolves(true)
        //     // const spy = sinon.stub(startSecurityScanWithProgress)
        //     await targetCommand.execute()
        //     assert.ok(true)
        //     // assert.ok(spy.called)
        // })

        
    })
})
