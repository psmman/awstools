/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import { CloudFormation, Lambda } from 'aws-sdk'
import * as os from 'os'
import * as vscode from 'vscode'
import { CloudFormationClient } from '../../shared/clients/cloudFormationClient'
import { LambdaClient } from '../../shared/clients/lambdaClient'
import { ext } from '../../shared/extensionGlobals'
import { AWSTreeErrorHandlerNode } from '../../shared/treeview/nodes/awsTreeErrorHandlerNode'
import { AWSTreeNodeBase } from '../../shared/treeview/nodes/awsTreeNodeBase'
import { ErrorNode } from '../../shared/treeview/nodes/errorNode'
import { PlaceholderNode } from '../../shared/treeview/nodes/placeholderNode'
import { intersection, toArrayAsync, toMap, toMapAsync, updateInPlace } from '../../shared/utilities/collectionUtils'
import { listCloudFormationStacks, listLambdaFunctions } from '../utils'
import { FunctionNodeBase } from './functionNode'

export class CloudFormationNode extends AWSTreeErrorHandlerNode {
    private readonly stackNodes: Map<string, CloudFormationStackNode>

    public constructor(private readonly regionCode: string) {
        super('CloudFormation', vscode.TreeItemCollapsibleState.Collapsed)
        this.stackNodes = new Map<string, CloudFormationStackNode>()
    }

    public async getChildren(): Promise<(CloudFormationStackNode | ErrorNode)[]> {
        await this.handleErrorProneOperation(
            async () => this.updateChildren(),
            localize('AWS.explorerNode.cloudFormation.error', 'Error loading CloudFormation resources')
        )

        return !!this.errorNode
            ? [this.errorNode]
            : [...this.stackNodes.values()].sort((nodeA, nodeB) => nodeA.stackName.localeCompare(nodeB.stackName))
    }

    public async updateChildren(): Promise<void> {
        const client: CloudFormationClient = ext.toolkitClientBuilder.createCloudFormationClient(this.regionCode)
        const stacks = await toMapAsync(listCloudFormationStacks(client), stack => stack.StackId)

        updateInPlace(
            this.stackNodes,
            stacks.keys(),
            key => this.stackNodes.get(key)!.update(stacks.get(key)!),
            key => new CloudFormationStackNode(this, this.regionCode, stacks.get(key)!)
        )
    }
}

export class CloudFormationStackNode extends AWSTreeErrorHandlerNode {
    private readonly functionNodes: Map<string, CloudFormationFunctionNode>

    public constructor(
        public readonly parent: AWSTreeNodeBase,
        public readonly regionCode: string,
        private stackSummary: CloudFormation.StackSummary
    ) {
        super('', vscode.TreeItemCollapsibleState.Collapsed)

        this.update(stackSummary)
        this.contextValue = 'awsCloudFormationNode'
        this.functionNodes = new Map<string, CloudFormationFunctionNode>()
        this.iconPath = {
            dark: vscode.Uri.file(ext.iconPaths.dark.cloudFormation),
            light: vscode.Uri.file(ext.iconPaths.light.cloudFormation)
        }
    }

    public get stackId(): CloudFormation.StackId | undefined {
        return this.stackSummary.StackId
    }

    public get stackName(): CloudFormation.StackName {
        return this.stackSummary.StackName
    }

    public async getChildren(): Promise<(CloudFormationFunctionNode | PlaceholderNode)[]> {
        await this.handleErrorProneOperation(
            async () => this.updateChildren(),
            localize('AWS.explorerNode.cloudFormation.error', 'Error loading CloudFormation resources')
        )

        if (!!this.errorNode) {
            return [this.errorNode]
        }

        if (this.functionNodes.size > 0) {
            return [...this.functionNodes.values()]
        }

        return [
            new PlaceholderNode(
                this,
                localize('AWS.explorerNode.cloudFormation.noFunctions', '[no functions in this CloudFormation]')
            )
        ]
    }

    public update(stackSummary: CloudFormation.StackSummary): void {
        this.stackSummary = stackSummary
        this.label = `${this.stackName} [${stackSummary.StackStatus}]`
        this.tooltip = `${this.stackName}${os.EOL}${this.stackId}`
    }

    private async updateChildren(): Promise<void> {
        const resources: string[] = await this.resolveLambdaResources()
        const client: LambdaClient = ext.toolkitClientBuilder.createLambdaClient(this.regionCode)
        const functions: Map<string, Lambda.FunctionConfiguration> = toMap(
            await toArrayAsync(listLambdaFunctions(client)),
            functionInfo => functionInfo.FunctionName
        )

        updateInPlace(
            this.functionNodes,
            intersection(resources, functions.keys()),
            key => this.functionNodes.get(key)!.update(functions.get(key)!),
            key => new CloudFormationFunctionNode(this, this.regionCode, functions.get(key)!)
        )
    }

    private async resolveLambdaResources(): Promise<string[]> {
        const client: CloudFormationClient = ext.toolkitClientBuilder.createCloudFormationClient(this.regionCode)
        const response = await client.describeStackResources(this.stackSummary.StackName)

        if (response.StackResources) {
            return response.StackResources.filter(it => it.ResourceType.includes('Lambda::Function')).map(
                it => it.PhysicalResourceId || 'none'
            )
        }

        return []
    }
}

export class CloudFormationFunctionNode extends FunctionNodeBase {
    public constructor(
        public readonly parent: AWSTreeNodeBase,
        public readonly regionCode: string,
        configuration: Lambda.FunctionConfiguration
    ) {
        super(parent, configuration)
        this.contextValue = 'awsCloudFormationFunctionNode'
    }
}
