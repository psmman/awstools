/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { makeChildrenNodes } from '../../shared/treeview/treeNodeUtilities'
import * as vscode from 'vscode'
import { AWSTreeNodeBase } from '../../shared/treeview/nodes/awsTreeNodeBase'
import { AppRunnerServiceNode } from './apprunnerServiceNode'
import { ErrorNode } from '../../shared/treeview/nodes/errorNode'
import { PlaceholderNode } from '../../shared/treeview/nodes/placeholderNode'
import * as nls from 'vscode-nls'
import { AppRunnerClient } from '../../shared/clients/apprunnerClient'
import { getPaginatedAwsCallIter } from '../../shared/utilities/collectionUtils'
import { AppRunner } from 'aws-sdk'

const localize = nls.loadMessageBundle()

const POLLING_INTERVAL = 20000
export class AppRunnerNode extends AWSTreeNodeBase {
    private readonly serviceNodes: Map<AppRunner.ServiceId, AppRunnerServiceNode> = new Map()
    private readonly pollingNodes: Set<string> = new Set()
    private pollTimer?: NodeJS.Timeout

    public constructor(public readonly region: string, public readonly client: AppRunnerClient) {
        super('App Runner', vscode.TreeItemCollapsibleState.Collapsed)
        this.contextValue = 'awsAppRunnerNode'
    }

    public async getChildren(): Promise<AWSTreeNodeBase[]> {
        return await makeChildrenNodes({
            getChildNodes: async () => {
                await this.updateChildren()

                return [...this.serviceNodes.values()]
            },
            getErrorNode: async (error: Error, logID: number) => new ErrorNode(this, error, logID),
            getNoChildrenPlaceholderNode: async () =>
                new PlaceholderNode(
                    this,
                    localize('AWS.explorerNode.apprunner.noServices', '[No App Runner services found]')
                ),
            sort: (nodeA: AppRunnerServiceNode, nodeB: AppRunnerServiceNode) =>
                nodeA.label!.localeCompare(nodeB.label!),
        })
    }

    private async getServiceSummaries(request: AppRunner.ListServicesRequest = {}): Promise<AppRunner.Service[]> {
        const iterator = getPaginatedAwsCallIter({
            awsCall: async request => await this.client.listServices(request),
            nextTokenNames: {
                request: 'NextToken',
                response: 'NextToken',
            },
            request,
        })

        const services: AppRunner.Service[] = []

        while (true) {
            const next = await iterator.next()

            next.value.ServiceSummaryList.forEach((summary: AppRunner.Service) => services.push(summary))

            if (next.done) {
                break
            }
        }

        return services
    }

    public async updateChildren(): Promise<void> {
        const serviceSummaries = await this.getServiceSummaries()
        const deletedNodeArns = new Set(this.serviceNodes.keys())

        await Promise.all(
            serviceSummaries.map(async summary => {
                if (this.serviceNodes.has(summary.ServiceArn)) {
                    this.serviceNodes.get(summary.ServiceArn)!.update(summary)
                } else {
                    // Get top-level operation (always the first element)
                    const operations = (
                        await this.client.listOperations({ MaxResults: 1, ServiceArn: summary.ServiceArn })
                    ).OperationSummaryList
                    const operation = operations && operations[0]?.EndedAt === undefined ? operations[0] : undefined
                    this.serviceNodes.set(
                        summary.ServiceArn,
                        new AppRunnerServiceNode(this, this.client, summary, operation as any)
                    )
                }
                deletedNodeArns.delete(summary.ServiceArn)
            })
        )

        deletedNodeArns.forEach(this.deleteNode.bind(this))
    }

    public startPolling(id: string): void {
        this.pollingNodes.add(id)
        this.pollTimer = this.pollTimer ?? setInterval(this.refresh.bind(this), POLLING_INTERVAL)
    }

    public stopPolling(id: string): void {
        this.pollingNodes.delete(id)
        this.serviceNodes.get(id)?.refresh()
        if (this.pollingNodes.size === 0 && this.pollTimer) {
            clearInterval(this.pollTimer)
            this.pollTimer = undefined
        }
    }

    public deleteNode(id: string): void {
        if (this.serviceNodes.has(id)) {
            this.serviceNodes.delete(id)
        }
    }

    public async createService(request: AppRunner.CreateServiceRequest): Promise<void> {
        await this.client.createService(request)
        this.refresh()
    }
}
