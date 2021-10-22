/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as assert from 'assert'
import { anything, capture, deepEqual, instance, mock, verify, when } from '../utilities/mockito'
import { ExtensionContext } from 'vscode'
import { YamlExtension } from '../../shared/extensions/yaml'
import {
    JsonSchemaHandler,
    JSONSchemaSettings,
    SchemaHandler,
    SchemaService,
    SchemaType,
    YamlSchemaHandler,
} from '../../shared/schemas'
import { FakeExtensionContext } from '../fakeExtensionContext'

describe('SchemaService', function () {
    let service: SchemaService
    let fakeExtensionContext: ExtensionContext
    let fakeConfig: vscode.WorkspaceConfiguration
    let fakeYamlExtension: YamlExtension
    const cfnSchema = vscode.Uri.file('cfn')
    const samSchema = vscode.Uri.file('sam')

    beforeEach(async function () {
        fakeExtensionContext = new FakeExtensionContext()
        fakeYamlExtension = mock()
        fakeConfig = mock()
        when(fakeConfig.update(anything(), anything(), anything())).thenResolve()
        service = new SchemaService(fakeExtensionContext, {
            schemas: {
                cfn: cfnSchema,
                sam: samSchema,
            },
            handlers: new Map<SchemaType, SchemaHandler>([
                ['json', new JsonSchemaHandler(instance(fakeConfig))],
                ['yaml', new YamlSchemaHandler(instance(fakeYamlExtension))],
            ]),
        })
    })

    it('assigns schemas to the yaml extension', async function () {
        service.registerMapping({
            path: '/foo',
            type: 'yaml',
            schema: 'cfn',
        })
        service.registerMapping({
            path: '/bar',
            type: 'yaml',
            schema: 'sam',
        })
        await service.processUpdates()
        verify(fakeYamlExtension.assignSchema(deepEqual(vscode.Uri.file('/foo')), cfnSchema)).once()
        verify(fakeYamlExtension.assignSchema(deepEqual(vscode.Uri.file('/bar')), samSchema)).once()
    })

    it('removes schemas from the yaml extension', async function () {
        service.registerMapping({
            path: '/foo',
            type: 'yaml',
            schema: undefined,
        })
        await service.processUpdates()
        verify(fakeYamlExtension.removeSchema(deepEqual(vscode.Uri.file('/foo')))).once()
    })

    it('registers schemas to json configuration', async function () {
        service.registerMapping({
            path: '/foo',
            type: 'json',
            schema: 'cfn',
        })
        await service.processUpdates()
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const [, configs] = capture(fakeConfig.update).last()
        assert.strictEqual(configs.length, 1)

        const schemaSettings = configs[0] as JSONSchemaSettings
        assert.strictEqual(schemaSettings.fileMatch?.length, 1)
        assert.strictEqual(schemaSettings.fileMatch[0], '/foo')
        assert.strictEqual(schemaSettings.url, cfnSchema.toString())
    })

    it('removes schemas from json configuration', async function () {
        service.registerMapping({
            path: '/foo',
            type: 'json',
            schema: undefined,
        })
        await service.processUpdates()
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const [, configs] = capture(fakeConfig.update).last()
        assert.strictEqual(configs.length, 0)
    })

    it('processes no updates if schemas are unavailable', async function () {
        fakeYamlExtension = mock()
        service = new SchemaService(fakeExtensionContext, {
            handlers: new Map<SchemaType, SchemaHandler>([
                ['json', new JsonSchemaHandler()],
                ['yaml', new YamlSchemaHandler(instance(fakeYamlExtension))],
            ]),
        })

        service.registerMapping({
            path: '/foo',
            type: 'yaml',
            schema: 'cfn',
        })
        await service.processUpdates()
        verify(fakeYamlExtension.assignSchema(anything(), anything())).never()
    })

    it('processes no updates if yaml extension unavailable', async function () {
        fakeYamlExtension = mock()
        service = new SchemaService(fakeExtensionContext)

        service.registerMapping({
            path: '/foo',
            type: 'yaml',
            schema: 'cfn',
        })
        await service.processUpdates()
        verify(fakeYamlExtension.assignSchema(anything(), anything())).never()
    })
})
