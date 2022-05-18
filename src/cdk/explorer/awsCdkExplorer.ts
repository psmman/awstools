/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { ResourceTreeDataProvider, TreeNode } from '../../shared/treeview/resourceTreeDataProvider'
import { createPlaceholderItem } from '../../shared/treeview/utils'
import { localize } from '../../shared/utilities/vsCodeUtils'
import { Commands } from '../../shared/vscode/commands2'
import { CdkProject } from './cdkProject'
import { detectCdkProjects } from './detectCdkProjects'
import { AppNode } from './nodes/appNode'

export async function getAppNodes(): Promise<TreeNode[]> {
    const appsFound = await detectCdkProjects(vscode.workspace.workspaceFolders)

    if (appsFound.length === 0) {
        return [createPlaceholderItem(localize('AWS.cdk.explorerNode.noApps', '[No CDK Apps found in Workspaces]'))]
    }

    return appsFound.map(appLocation => new AppNode(appLocation))
}

class CdkProjectRegistry {
    private watcher?: vscode.FileSystemWatcher
    private readonly projects = new Map<string, CdkProject>()
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>()
    public readonly onDidChange = this.onDidChangeEmitter.event

    public constructor() {}

    public getProjects(): CdkProject[] {
        this.watcher ??= this.createWatcher()

        return Array.from(this.projects.values())
    }

    public async findProjects(): Promise<CdkProject[]> {
        const pattern = '**/cdk.json'
        const excludePattern = '**/{node_modules,.aws-sam}/**'
        const cdkJsonFiles = await vscode.workspace.findFiles(pattern, excludePattern)

        this.clear()

        const projects = await Promise.all(cdkJsonFiles.map(f => CdkProject.fromManifest(f)))
        projects.forEach(p => this.projects.set(p.manifest.toString(), p))
        this.onDidChangeEmitter.fire()

        return projects
    }

    private clear(): void {
        vscode.Disposable.from(...this.projects.values()).dispose()
        this.projects.clear()
    }

    private createWatcher(): vscode.FileSystemWatcher {
        const pattern = '**/cdk.json'
        const watcher = vscode.workspace.createFileSystemWatcher(pattern)

        watcher.onDidCreate(async uri => {
            const project = await CdkProject.fromManifest(uri)
            this.projects.set(uri.toString(), project)
            this.onDidChangeEmitter.fire()
        })

        watcher.onDidChange(async uri => {
            this.projects.get(uri.toString())?.dispose()
            const project = await CdkProject.fromManifest(uri)
            this.projects.set(uri.toString(), project)
            this.onDidChangeEmitter.fire()
        })

        watcher.onDidDelete(async uri => {
            this.projects.get(uri.toString())?.dispose()
            this.projects.delete(uri.toString())
            this.onDidChangeEmitter.fire()
        })

        return watcher
    }
}

export class CdkRootNode implements TreeNode {
    public readonly id = 'cdk'
    public readonly treeItem = this.createTreeItem()
    public readonly resource = this
    private readonly onDidChangeChildrenEmitter = new vscode.EventEmitter<void>()
    public readonly onDidChangeChildren = this.onDidChangeChildrenEmitter.event

    public async getChildren() {
        return getAppNodes()
    }

    public refresh(): void {
        this.onDidChangeChildrenEmitter.fire()
    }

    private createTreeItem() {
        const item = new vscode.TreeItem('CDK')
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
        item.contextValue = 'awsCdkRootNode'

        return item
    }
}

export const cdkNode = new CdkRootNode()
export const refreshCdkExplorer = Commands.register('aws.cdk.refresh', cdkNode.refresh.bind(cdkNode))

export function createCdkTreeDataProvider(): ResourceTreeDataProvider {
    return new ResourceTreeDataProvider({ getChildren: getAppNodes })
}
