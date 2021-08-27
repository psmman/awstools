/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'fs-extra'
import * as vscode from 'vscode'
import { VSCODE_EXTENSION_ID } from '../extensions'
import { getLogger } from '../logger/logger'

// sourced from https://github.com/redhat-developer/vscode-yaml/blob/3d82d61ea63d3e3a9848fe6b432f8f1f452c1bec/src/schema-extension-api.ts
// removed everything that is not currently being used
interface YamlExtensionApi {
    registerContributor(
        schema: string,
        requestSchema: (resource: string) => string | undefined,
        requestSchemaContent: (uri: string) => string,
        label?: string
    ): boolean
}

const AWS_SCHEME = 'aws-schema'

function applyScheme(scheme: string, path: vscode.Uri): vscode.Uri {
    return vscode.Uri.parse(`${scheme}://${path.fsPath}`)
}

function evaluate(schema: vscode.Uri | (() => vscode.Uri)): vscode.Uri {
    return schema instanceof Function ? schema() : schema
}

export interface CloudFormationSchemas {
    standard: vscode.Uri
    sam: vscode.Uri
}

export interface YamlExtension {
    assignSchema(path: vscode.Uri, schema: vscode.Uri | (() => vscode.Uri)): void
    removeSchema(path: vscode.Uri): void
}

export async function activateYamlExtension(): Promise<YamlExtension> {
    const yamlExt = vscode.extensions.getExtension<YamlExtensionApi>(VSCODE_EXTENSION_ID.yaml)
    const schemaMap = new Map<string, vscode.Uri>()

    if (yamlExt !== undefined) {
        try {
            const extApi = await yamlExt.activate()
            extApi.registerContributor(
                AWS_SCHEME,
                resource => {
                    return schemaMap.get(resource)?.toString()
                },
                uri => {
                    return readFileSync(vscode.Uri.parse(uri).fsPath).toString()
                }
            )
        } catch (err) {
            getLogger().error('Failed to activate YAML extension: %O', err)
            throw err
        }
    }

    return {
        assignSchema: (path, schema) => schemaMap.set(path.toString(), applyScheme(AWS_SCHEME, evaluate(schema))),
        removeSchema: path => schemaMap.delete(path.toString()),
    }
}
