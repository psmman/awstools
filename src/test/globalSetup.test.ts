/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Before/After hooks for all "unit" tests
 */
import assert from 'assert'
import * as sinon from 'sinon'
import vscode from 'vscode'
import { appendFileSync, mkdirpSync, remove } from 'fs-extra'
import { join } from 'path'
import { format } from 'util'
import globals from '../shared/extensionGlobals'
import { VSCODE_EXTENSION_ID } from '../shared/extensions'
import { CodelensRootRegistry } from '../shared/fs/codelensRootRegistry'
import { CloudFormationTemplateRegistry } from '../shared/fs/templateRegistry'
import { getLogger, LogLevel } from '../shared/logger'
import { setLogger } from '../shared/logger/logger'
import { activateExtension } from '../shared/utilities/vsCodeUtils'
import { FakeExtensionContext, FakeMemento } from './fakeExtensionContext'
import { TestLogger } from './testLogger'
import * as testUtil from './testUtil'
import { getTestWindow, resetTestWindow } from './shared/vscode/window'
import { mapTestErrors, normalizeError, setRunnableTimeout } from './setupUtil'
import { TelemetryDebounceInfo } from '../shared/vscode/commands2'
import { TelemetrySpan } from '../shared/telemetry/spans'
import { Result } from '../shared/telemetry/telemetry.gen'
import { Hook } from 'mocha'

const testReportDir = join(__dirname, '../../../.test-reports')
const testLogOutput = join(testReportDir, 'testLog.log')
const globalSandbox = sinon.createSandbox()
const maxTestDuration = 30_000

// Expectation: Tests are not run concurrently
let testLogger: TestLogger | undefined
let openExternalStub: sinon.SinonStub<Parameters<(typeof vscode)['env']['openExternal']>, Thenable<boolean>>
let telemetrySpanSpy: sinon.SinonSpy
// let executeCommandSpy: sinon.SinonSpy | undefined

export async function mochaGlobalSetup(this: Mocha.Runner) {
    // Clean up and set up test logs
    try {
        await remove(testLogOutput)
    } catch (e) {}
    mkdirpSync(testReportDir)

    // Shows the full error chain when tests fail
    mapTestErrors(this, normalizeError)

    // Extension activation has many side-effects such as changing globals
    // For stability in tests we will wait until the extension has activated prior to injecting mocks
    const activationLogger = (msg: string, ...meta: any[]) => console.log(format(msg, ...meta))
    await activateExtension(VSCODE_EXTENSION_ID.awstoolkit, false, activationLogger)
    const fakeContext = await FakeExtensionContext.create()
    fakeContext.globalStorageUri = (await testUtil.createTestWorkspaceFolder('globalStoragePath')).uri
    fakeContext.extensionPath = globals.context.extensionPath
    Object.assign(globals, { context: fakeContext })
}

export async function mochaGlobalTeardown(this: Mocha.Context) {
    testUtil.deleteTestTempDirs()
}

export const mochaHooks = {
    async beforeEach(this: Mocha.Context) {
        // Set every test up so that TestLogger is the logger used by toolkit code
        testLogger = setupTestLogger()
        globals.templateRegistry = (async () => new CloudFormationTemplateRegistry())()
        globals.codelensRootRegistry = new CodelensRootRegistry()

        // In general, we do not want to "fake" the `vscode` API. The only exception is for things
        // that _require_ user input apart of a workflow. Even then, these replacements are intended
        // to be minimally intrusive and as close to the real thing as possible.
        globalSandbox.replace(vscode, 'window', getTestWindow())
        openExternalStub = globalSandbox.stub(vscode.env, 'openExternal')
        openExternalStub.returns(undefined as any) // Detected in afterEach() below.

        // Wraps the test function to bubble up errors that occurred in events from `TestWindow`
        if (this.currentTest?.fn) {
            setRunnableTimeout(this.currentTest, maxTestDuration)
        }

        // Enable telemetry features for tests. The metrics won't actually be posted.
        globals.telemetry.telemetryEnabled = true
        globals.telemetry.clearRecords()
        globals.telemetry.logger.clear()
        TelemetryDebounceInfo.instance.clear()
        ;(globals.context as FakeExtensionContext).globalState = new FakeMemento()
        telemetrySpanSpy = sinon.spy(TelemetrySpan.prototype, 'emit')

        await testUtil.closeAllEditors()
    },
    async afterEach(this: Mocha.Context) {
        if (openExternalStub.called && openExternalStub.returned(sinon.match.typeOf('undefined'))) {
            throw new Error(
                `Test called openExternal(${
                    getOpenExternalStub().args[0]
                }) without first configuring getOpenExternalStub().resolves().`
            )
        }

        // Prevent other tests from using the same TestLogger instance
        teardownTestLogger(this.currentTest?.fullTitle() as string)
        testLogger = undefined
        resetTestWindow()
        const r = await globals.templateRegistry
        r.dispose()
        globals.codelensRootRegistry.dispose()
        globalSandbox.restore()

        // Don't run any validations for tests on telemetry
        if (!(this.currentTest ?? this.test)?.file?.includes('shared/telemetry/')) {
            validateTelemetryEmitCalls(this.test as Hook, telemetrySpanSpy)
        }
        telemetrySpanSpy.restore()

        // executeCommandSpy = undefined
    },
}

/**
 * Provides the TestLogger to tests that want to access it.
 * Verifies that the TestLogger instance is still the one set as the toolkit's logger.
 */
export function getTestLogger(): TestLogger {
    const logger = getLogger()
    assert.strictEqual(logger, testLogger, 'The expected test logger is not the current logger')
    assert.ok(testLogger, 'TestLogger was expected to exist')

    return logger!
}

function setupTestLogger(): TestLogger {
    // write the same logger to each channel.
    // That way, we don't have to worry about which channel is being logged to for inspection.
    const logger = new TestLogger()
    setLogger(logger, 'main')
    setLogger(logger, 'channel')
    setLogger(logger, 'debugConsole')

    return logger
}

function teardownTestLogger(testName: string) {
    writeLogsToFile(testName)

    setLogger(undefined, 'main')
    setLogger(undefined, 'channel')
    setLogger(undefined, 'debugConsole')
}

function writeLogsToFile(testName: string) {
    const entries = testLogger?.getLoggedEntries()
    entries?.unshift(`=== Starting test "${testName}" ===`)
    entries?.push(`=== Ending test "${testName}" ===\n\n`)
    appendFileSync(testLogOutput, entries?.join('\n') ?? '', 'utf8')
}

/*
 * Validates that telemetry emit() calls for the the given Mocha Context test session 1. contain a result property
 * and 2. contain a reason propery is the result is 'Failed'. NOTE: This assume that this function is called in
 * the afterEach hook.
 *
 * TODO: While this catches cases in code that is tested, untested code will still release incomplete metrics.
 * Consider using custom lint rules to address all cases if possible.
 */
function validateTelemetryEmitCalls(testHook: Hook, spy: sinon.SinonSpy) {
    const failedStr: Result = 'Failed'
    const telemetryRunDocsStr =
        'Consider using `.run()` instead, which will set these properties automatically. ' +
        'See https://github.com/aws/aws-toolkit-vscode/blob/master/docs/telemetry.md#guidelines'

    for (const c of spy.getCalls()) {
        const metricName = c.thisValue.name
        const missingResultErrMsg =
            `This test calls \`${metricName}.emit({...})\` without the \`result\` property. ` +
            `This property is always required. ${telemetryRunDocsStr}`
        const missingReasonErrMsg =
            `This test calls \`${metricName}.emit({...result: 'Failed'})\` without the \`reason\` property. ` +
            `This property is always required when \`result\` = 'Failed'. ${telemetryRunDocsStr}`

        const data = c.args[0]
        if (data) {
            if (data.result === undefined) {
                // This function is meant to be called in the afterEach() hook. We can force the test to fail with this
                // strategy. If we used an assert statement, then the test session would exit immediately on the first fail.
                testHook.error(new Error(missingResultErrMsg))
            }
            if (data.result === failedStr && data.reason === undefined) {
                testHook.error(new Error(missingReasonErrMsg))
            }
        }
    }
}

export function assertLogsContain(text: string, exactMatch: boolean, severity: LogLevel) {
    assert.ok(
        getTestLogger()
            .getLoggedEntries(severity)
            .some(e =>
                e instanceof Error
                    ? exactMatch
                        ? e.message === text
                        : e.message.includes(text)
                    : exactMatch
                    ? e === text
                    : e.includes(text)
            ),
        `Expected to find "${text}" in the logs as type "${severity}"`
    )
}

export function getOpenExternalStub(): typeof openExternalStub {
    return openExternalStub
}

// /**
//  * Returns a spy for `vscode.commands.executeCommand()`.
//  *
//  * Opt-in per test, because most tests should test application state instead of spies.
//  * Global `afterEach` automatically calls `globalSandbox.restore()` after the test run.
//  */
// export function stubVscodeExecuteCommand() {
//     executeCommandSpy = executeCommandSpy ?? globalSandbox.spy(vscode.commands, 'executeCommand')
//     return executeCommandSpy
// }
