/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import _ = require('lodash')
import xml2js = require('xml2js')
import * as fs from 'fs-extra'
import * as path from 'path'
import * as vscode from 'vscode'
import { LaunchConfiguration } from '../../shared/debug/launchConfiguration'
import { ext } from '../../shared/extensionGlobals'
import { ExtContext } from '../../shared/extensions'
import { getLogger } from '../../shared/logger'
import { CompositeResourceFetcher } from '../../shared/resourcefetcher/compositeResourceFetcher'
import { FileResourceFetcher } from '../../shared/resourcefetcher/fileResourceFetcher'
import { HttpResourceFetcher } from '../../shared/resourcefetcher/httpResourceFetcher'
import { ResourceFetcher } from '../../shared/resourcefetcher/resourcefetcher'
import {
    AwsSamDebuggerConfiguration,
    isCodeTargetProperties,
    isTemplateTargetProperties,
} from '../../shared/sam/debugger/awsSamDebugConfiguration'
import { DefaultAwsSamDebugConfigurationValidator } from '../../shared/sam/debugger/awsSamDebugConfigurationValidator'
import { SamDebugConfigProvider } from '../../shared/sam/debugger/awsSamDebugger'
import * as input from '../../shared/ui/input'
import * as picker from '../../shared/ui/picker'
import { addCodiconToString } from '../../shared/utilities/textUtilities'
import { createVueWebview } from '../../webviews/main'
import { sampleRequestManifestPath, sampleRequestPath } from '../constants'
import { tryGetAbsolutePath } from '../../shared/utilities/workspaceUtils'
import { CloudFormation } from '../../shared/cloudformation/cloudformation'

export function registerSamInvokeVueCommand(context: ExtContext): vscode.Disposable {
    return vscode.commands.registerCommand('aws.lambda.vueTest', async (launchConfig?: AwsSamDebuggerConfiguration) => {
        await createVueWebview<SamInvokerRequest, SamInvokerResponse, SamInvokerResponse>({
            id: 'create',
            name: 'Invoke Local SAM Application',
            webviewJs: 'samInvokeVue.js',
            onDidReceiveMessageFunction: async (message, postMessageFn, destroyWebviewFn) =>
                handleFrontendToBackendMessage(message, postMessageFn, destroyWebviewFn, context),
            context: context.extensionContext,
            cssFiles: ['samInvokeForm.css'],
            initialState: launchConfig
                ? {
                      command: 'loadSamLaunchConfig',
                      data: {
                          launchConfig: launchConfig,
                      },
                  }
                : undefined,
        })
    })
}

export interface SamInvokeVueState {
    launchConfig: MorePermissiveAwsSamDebuggerConfiguration
    payload: string
}

export interface MorePermissiveAwsSamDebuggerConfiguration extends AwsSamDebuggerConfiguration {
    invokeTarget: {
        target: 'template' | 'api' | 'code'
        templatePath: string
        logicalId: string
        lambdaHandler: string
        projectRoot: string
    }
}

export interface LoadSamLaunchConfigResponse {
    command: 'loadSamLaunchConfig'
    data: {
        launchConfig: AwsSamDebuggerConfiguration
    }
}

export interface GetSamplePayloadResponse {
    command: 'getSamplePayload'
    data: {
        payload: string
    }
}

export interface GetTemplateResponse {
    command: 'getTemplate'
    data: {
        template: string
        logicalId: string
    }
}

export interface SamInvokerBasicRequest {
    command: 'loadSamLaunchConfig' | 'getSamplePayload' | 'getTemplate'
}

export interface SamInvokerLaunchRequest {
    command: 'saveLaunchConfig' | 'invokeLaunchConfig'
    data: {
        launchConfig: AwsSamDebuggerConfiguration
    }
}

export type SamInvokerRequest = SamInvokerBasicRequest | SamInvokerLaunchRequest
export type SamInvokerResponse = LoadSamLaunchConfigResponse | GetSamplePayloadResponse | GetTemplateResponse

async function handleFrontendToBackendMessage(
    message: SamInvokerRequest,
    postMessageFn: (response: SamInvokerResponse) => Thenable<boolean>,
    destroyWebviewFn: () => any,
    context: ExtContext
): Promise<any> {
    switch (message.command) {
        case 'loadSamLaunchConfig':
            loadSamLaunchConfig(postMessageFn)
            break
        case 'getSamplePayload':
            getSamplePayload(postMessageFn)
            break
        case 'getTemplate':
            getTemplate(postMessageFn)
            break
        case 'saveLaunchConfig':
            saveLaunchConfig(message.data.launchConfig)
            break
        case 'invokeLaunchConfig':
            invokeLaunchConfig(message.data.launchConfig, context)
            break
    }
}

/**
 * Open a quick pick containing the names of launch configs in the `launch.json` array.
 * Filter out non-supported launch configs.
 * Call back into the webview with the selected launch config.
 * @param postMessageFn
 */
async function loadSamLaunchConfig(postMessageFn: (response: SamInvokerResponse) => Thenable<boolean>): Promise<void> {
    // TODO: Find a better way to infer this. Might need another arg from the frontend (depends on the context in which the launch config is made?)
    const workspaceFolder = vscode.workspace.workspaceFolders?.length ? vscode.workspace.workspaceFolders[0] : undefined
    if (!workspaceFolder) {
        // TODO Localize
        vscode.window.showErrorMessage('No workspace folder found.')
        return
    }
    const uri = workspaceFolder.uri
    const launchConfig = new LaunchConfiguration(uri)
    const pickerItems = getLaunchConfigQuickPickItems(launchConfig, uri)
    if (pickerItems.length === 0) {
        // TODO Localize
        vscode.window.showErrorMessage('No launch configurations found')
        return
    }
    const qp = picker.createQuickPick({
        items: pickerItems,
        options: {
            title: 'Select Debug Configuration',
        },
    })

    const choices = await picker.promptUser({
        picker: qp,
    })
    const pickerResponse = picker.verifySinglePickerOutput<LaunchConfigPickItem>(choices)

    if (!pickerResponse) {
        return
    }
    postMessageFn({
        command: 'loadSamLaunchConfig',
        data: {
            launchConfig: pickerResponse.config!,
        },
    })
}

interface SampleRequestManifest {
    requests: {
        request: {
            name?: string
            filename?: string
        }[]
    }
}

interface SampleQuickPickItem extends vscode.QuickPickItem {
    filename: string
}

/**
 * Open a quick pick containing upstream sample payloads.
 * Call back into the webview with the contents of the payload to add to the JSON field.
 * @param postMessageFn
 */
async function getSamplePayload(postMessageFn: (response: SamInvokerResponse) => Thenable<boolean>): Promise<void> {
    // stolen from invokeLambda.ts
    try {
        const sampleInput = await makeSampleRequestManifestResourceFetcher().get()

        if (!sampleInput) {
            throw new Error('Unable to retrieve Sample Request manifest')
        }

        getLogger().debug(`Loaded: ${sampleInput}`)

        const inputs: SampleQuickPickItem[] = []

        await new Promise<void>((resolve, reject) => {
            xml2js.parseString(sampleInput, { explicitArray: false }, (err: Error, result: SampleRequestManifest) => {
                if (err) {
                    reject()
                }

                _.forEach(result.requests.request, r => {
                    inputs.push({ label: r.name ?? '', filename: r.filename ?? '' })
                })
                resolve()
            })
        })

        const qp = picker.createQuickPick({
            items: inputs,
            options: {
                title: 'Pick a sample input',
            },
        })

        const choices = await picker.promptUser({
            picker: qp,
        })
        const pickerResponse = picker.verifySinglePickerOutput<SampleQuickPickItem>(choices)

        if (!pickerResponse) {
            return
        }
        const sampleUrl = `${sampleRequestPath}${pickerResponse.filename}`
        const sample = (await new HttpResourceFetcher(sampleUrl, { showUrl: true }).get()) ?? ''
        // declaring here so we don't get an error
        sample

        postMessageFn({
            command: 'getSamplePayload',
            data: {
                payload: sample,
            },
        })
    } catch (err) {
        getLogger().error('Error getting manifest data..: %O', err as Error)
    }
}

/**
 * Get all templates in the registry.
 * Call back into the webview with the registry contents.
 * @param postMessageFn
 */
async function getTemplate(postMessageFn: (response: SamInvokerResponse) => Thenable<boolean>): Promise<void> {
    const items: (vscode.QuickPickItem & { templatePath: string })[] = []
    for (const template of ext.templateRegistry.registeredItems) {
        const resources = template.item.Resources
        if (resources) {
            for (const resource of Object.keys(resources)) {
                if (
                    resources[resource]?.Type === CloudFormation.LAMBDA_FUNCTION_TYPE ||
                    resources[resource]?.Type === CloudFormation.SERVERLESS_FUNCTION_TYPE ||
                    resources[resource]?.Type === CloudFormation.SERVERLESS_API_TYPE
                ) {
                    items.push({
                        label: resource,
                        detail: `Template: ${template.path}`,
                        templatePath: template.path,
                    })
                }
            }
        }
    }

    if (items.length === 0) {
        vscode.window.showWarningMessage('No templates with valid SAM functions found.')
        return
    }

    const qp = picker.createQuickPick({
        items,
        options: {
            title: 'Select Resource',
        },
    })

    const choices = await picker.promptUser({
        picker: qp,
    })
    const selectedTemplate = picker.verifySinglePickerOutput(choices)

    if (!selectedTemplate) {
        return
    }

    postMessageFn({
        command: 'getTemplate',
        data: {
            logicalId: selectedTemplate.label,
            template: selectedTemplate.templatePath,
        },
    })
}

interface LaunchConfigPickItem extends vscode.QuickPickItem {
    index: number
    config?: AwsSamDebuggerConfiguration
}

/**
 * Open a quick pick containing the names of launch configs in the `launch.json` array, plus a "Create New Entry" entry.
 * On selecting a name, overwrite the existing entry in the `launch.json` array and resave the file.
 * On selecting "Create New Entry", prompt the user for a name and save the contents to the end of the `launch.json` array.
 * @param config Config to save
 */
async function saveLaunchConfig(config: AwsSamDebuggerConfiguration): Promise<void> {
    const uri = getUriFromLaunchConfig(config)
    if (!uri) {
        // TODO Localize
        vscode.window.showErrorMessage('Toolkit requires a target resource in order to save a debug configuration')
        return
    }
    const launchConfig = new LaunchConfiguration(uri)
    const pickerItems = getLaunchConfigQuickPickItems(launchConfig, uri)

    pickerItems.unshift({
        label: addCodiconToString('add', 'Create New Debug Configuration'),
        index: -1,
    })

    const qp = picker.createQuickPick({
        items: pickerItems,
        options: {
            title: 'Select Debug Configuration',
        },
    })

    const choices = await picker.promptUser({
        picker: qp,
    })
    const pickerResponse = picker.verifySinglePickerOutput<LaunchConfigPickItem>(choices)

    if (!pickerResponse) {
        return
    }

    if (pickerResponse.index === -1) {
        const ib = input.createInputBox({
            options: {
                prompt: 'Enter Name For Debug Configuration',
            },
        })
        const response = await input.promptUser({ inputBox: ib })
        if (response) {
            launchConfig.addDebugConfiguration(pruneConfig(config, response))
        }
    } else {
        // use existing label
        launchConfig.editDebugConfiguration(pruneConfig(config, pickerResponse.label), pickerResponse.index)
    }
}

/**
 * Validate and execute the provided launch config.
 * TODO: Post validation failures back to webview?
 * @param config Config to invoke
 */
async function invokeLaunchConfig(config: AwsSamDebuggerConfiguration, context: ExtContext): Promise<void> {
    const targetUri = getUriFromLaunchConfig(config)

    const folder = targetUri ? vscode.workspace.getWorkspaceFolder(targetUri) : undefined

    await new SamDebugConfigProvider(context).resolveDebugConfiguration(folder, config)
}

function getUriFromLaunchConfig(config: AwsSamDebuggerConfiguration): vscode.Uri | undefined {
    let targetPath: string
    if (isTemplateTargetProperties(config.invokeTarget)) {
        targetPath = config.invokeTarget.templatePath
    } else if (isCodeTargetProperties(config.invokeTarget)) {
        targetPath = config.invokeTarget.projectRoot
    } else {
        // error
        return undefined
    }
    if (path.isAbsolute(targetPath)) {
        return vscode.Uri.file(targetPath)
    }
    const workspaceFolders = vscode.workspace.workspaceFolders || []
    for (const workspaceFolder of workspaceFolders) {
        const absolutePath = tryGetAbsolutePath(workspaceFolder, targetPath)
        if (fs.pathExistsSync(absolutePath)) {
            return vscode.Uri.file(absolutePath)
        }
    }

    return undefined
}

function makeSampleRequestManifestResourceFetcher(): ResourceFetcher {
    return new CompositeResourceFetcher(
        new HttpResourceFetcher(sampleRequestManifestPath, { showUrl: true }),
        new FileResourceFetcher(ext.manifestPaths.lambdaSampleRequests)
    )
}

function getLaunchConfigQuickPickItems(launchConfig: LaunchConfiguration, uri: vscode.Uri): LaunchConfigPickItem[] {
    const existingConfigs = launchConfig.getDebugConfigurations()
    const samValidator = new DefaultAwsSamDebugConfigurationValidator(vscode.workspace.getWorkspaceFolder(uri))
    return existingConfigs
        .map((val, index) => {
            return {
                config: val,
                index,
            }
        })
        .filter(o => samValidator.validate((o.config as any) as AwsSamDebuggerConfiguration)?.isValid)
        .map(val => {
            return {
                index: val.index,
                label: val.config.name,
                config: val.config as AwsSamDebuggerConfiguration,
            }
        })
}

function pruneConfig(config: AwsSamDebuggerConfiguration, name: string): AwsSamDebuggerConfiguration {
    const newConfig = pruneConfigHelper(config)
    newConfig.name = name

    if (isTemplateTargetProperties(config.invokeTarget)) {
        newConfig.invokeTarget = {
            target: config.invokeTarget.target,
            logicalId: config.invokeTarget.logicalId,
            templatePath: config.invokeTarget.templatePath,
        }
    } else if (isCodeTargetProperties(config.invokeTarget)) {
        newConfig.invokeTarget = {
            target: config.invokeTarget.target,
            lambdaHandler: config.invokeTarget.lambdaHandler,
            projectRoot: config.invokeTarget.projectRoot,
        }
    }

    return newConfig
}

function pruneConfigHelper(object: { [key: string]: any }): any | undefined {
    const keys = Object.keys(object)
    const final: any = {}
    for (const key of keys) {
        const val = object[key]
        if (val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) {
            if (typeof val === 'object') {
                const pruned = pruneConfigHelper(val)
                if (pruned) {
                    final[key] = pruned
                }
            } else {
                final[key] = val
            }
        }
    }
    if (Object.keys(final).length === 0) {
        return undefined
    }

    return final
}
