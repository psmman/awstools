/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import {
    AwsSamDebuggerConfiguration,
    CodeTargetProperties,
    TemplateTargetProperties,
} from './awsSamDebugConfiguration.gen'

export * from './awsSamDebugConfiguration.gen'

export const AWS_SAM_DEBUG_TYPE = 'aws-sam'
export const DIRECT_INVOKE_TYPE = 'direct-invoke'
export const TEMPLATE_TARGET_TYPE: 'template' = 'template'
export const CODE_TARGET_TYPE: 'code' = 'code'
export const AWS_SAM_DEBUG_REQUEST_TYPES = [DIRECT_INVOKE_TYPE]
export const AWS_SAM_DEBUG_TARGET_TYPES = [TEMPLATE_TARGET_TYPE, CODE_TARGET_TYPE]

export type TargetProperties = AwsSamDebuggerConfiguration['invokeTarget']

export interface ReadonlyJsonObject {
    readonly [key: string]: string | number | boolean
}

export function isAwsSamDebugConfiguration(config: vscode.DebugConfiguration): config is AwsSamDebuggerConfiguration {
    return config.type === AWS_SAM_DEBUG_TYPE
}

export function isTemplateTargetProperties(props: TargetProperties): props is TemplateTargetProperties {
    return props.target === TEMPLATE_TARGET_TYPE
}

export function isCodeTargetProperties(props: TargetProperties): props is CodeTargetProperties {
    return props.target === CODE_TARGET_TYPE
}

export function createTemplateAwsSamDebugConfig(
    resourceName: string,
    templatePath: string,
    preloadedConfig?: {
        eventJson?: ReadonlyJsonObject
        environmentVariables?: ReadonlyJsonObject
        dockerNetwork?: string
        useContainer?: boolean
    }
): AwsSamDebuggerConfiguration {
    let response: AwsSamDebuggerConfiguration = {
        type: AWS_SAM_DEBUG_TYPE,
        request: DIRECT_INVOKE_TYPE,
        name: resourceName,
        invokeTarget: {
            target: TEMPLATE_TARGET_TYPE,
            samTemplatePath: templatePath,
            samTemplateResource: resourceName,
        },
    }

    if (preloadedConfig) {
        let addition: Partial<AwsSamDebuggerConfiguration> = {}

        if (preloadedConfig.eventJson) {
            addition = {
                ...addition,
                lambda: {
                    event: {
                        json: preloadedConfig.eventJson,
                    },
                },
            }
        }
        if (preloadedConfig.environmentVariables) {
            addition = {
                ...addition,
                lambda: {
                    ...addition.lambda,
                    environmentVariables: preloadedConfig.environmentVariables,
                },
            }
        }
        if (preloadedConfig.dockerNetwork) {
            addition = {
                ...addition,
                sam: {
                    dockerNetwork: preloadedConfig.dockerNetwork,
                },
            }
        }
        if (preloadedConfig.useContainer) {
            addition = {
                ...addition,
                sam: {
                    ...addition.sam,
                    containerBuild: preloadedConfig.useContainer,
                },
            }
        }
        response = {
            ...response,
            ...addition,
        }
    }

    return response
}
