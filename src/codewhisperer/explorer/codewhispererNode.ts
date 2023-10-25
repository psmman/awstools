/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import globals from '../../shared/extensionGlobals'
import * as CodeWhispererConstants from '../models/constants'
import {
    createAutoSuggestions,
    createOpenReferenceLog,
    createSecurityScan,
    createLearnMore,
    createSignIn,
    createFreeTierLimitMet,
    createSelectCustomization,
    createReconnect,
    createGettingStarted,
    createSignout,
} from './codewhispererChildrenNodes'
import { Command, Commands } from '../../shared/vscode/commands2'
import { RootNode } from '../../awsexplorer/localExplorer'
import { hasVendedIamCredentials } from '../../auth/auth'
import { AuthUtil } from '../util/authUtil'
import { TreeNode } from '../../shared/treeview/resourceTreeDataProvider'
import { DataQuickPickItem } from '../../shared/ui/pickerPrompter'

export class CodeWhispererNode implements RootNode {
    public readonly id = 'codewhisperer'
    public readonly resource = this
    private readonly onDidChangeChildrenEmitter = new vscode.EventEmitter<void>()
    private readonly onDidChangeTreeItemEmitter = new vscode.EventEmitter<void>()
    public readonly onDidChangeTreeItem = this.onDidChangeTreeItemEmitter.event
    public readonly onDidChangeChildren = this.onDidChangeChildrenEmitter.event
    private readonly onDidChangeVisibilityEmitter = new vscode.EventEmitter<void>()
    public readonly onDidChangeVisibility = this.onDidChangeVisibilityEmitter.event
    private _showFreeTierLimitReachedNode = false

    constructor() {}

    public getTreeItem() {
        const item = new vscode.TreeItem('CodeWhisperer')
        item.description = this.getDescription()
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
        item.contextValue = AuthUtil.instance.isUsingSavedConnection
            ? 'awsCodeWhispererNodeSaved'
            : 'awsCodeWhispererNode'

        return item
    }

    public refresh(): void {
        this.onDidChangeChildrenEmitter.fire()
    }

    public refreshRootNode() {
        this.onDidChangeTreeItemEmitter.fire()
    }

    private getDescription(): string {
        if (AuthUtil.instance.isConnectionValid()) {
            if (AuthUtil.instance.isEnterpriseSsoInUse()) {
                return 'IAM Identity Center Connected'
            } else if (AuthUtil.instance.isBuilderIdInUse()) {
                return 'AWS Builder ID Connected'
            } else {
                return 'IAM Connected'
            }
        } else if (AuthUtil.instance.isConnectionExpired()) {
            return 'Expired Connection'
        }
        return ''
    }

    public getChildren(): TreeNode<Command>[]
    public getChildren(type: 'item'): DataQuickPickItem<string>[]
    public getChildren(type: 'tree' | 'item'): TreeNode<Command>[] | DataQuickPickItem<string>[]
    public getChildren(type: 'tree' | 'item' = 'tree'): any[] {
        const _getChildren = () => {
            const autoTriggerEnabled =
                globals.context.globalState.get<boolean>(CodeWhispererConstants.autoTriggerEnabledKey) || false
            if (AuthUtil.instance.isConnectionExpired()) {
                return [createReconnect(type), createLearnMore(type)]
            }
            if (!AuthUtil.instance.isConnected()) {
                return [createSignIn(type), createLearnMore(type)]
            }
            if (this._showFreeTierLimitReachedNode) {
                if (hasVendedIamCredentials()) {
                    return [createFreeTierLimitMet(type), createOpenReferenceLog(type)]
                } else {
                    return [createFreeTierLimitMet(type), createSecurityScan(type), createOpenReferenceLog(type)]
                }
            } else {
                if (hasVendedIamCredentials()) {
                    return [createAutoSuggestions(type, autoTriggerEnabled), createOpenReferenceLog(type)]
                } else {
                    if (
                        AuthUtil.instance.isValidEnterpriseSsoInUse() &&
                        AuthUtil.instance.isCustomizationFeatureEnabled
                    ) {
                        return [
                            createAutoSuggestions(type, autoTriggerEnabled),
                            createSecurityScan(type),
                            createSelectCustomization(type),
                            createOpenReferenceLog(type),
                            createGettingStarted(type), // "Learn" node : opens Learn CodeWhisperer page
                        ]
                    }
                    return [
                        createAutoSuggestions(type, autoTriggerEnabled),
                        createSecurityScan(type),
                        createOpenReferenceLog(type),
                        createGettingStarted(type), // "Learn" node : opens Learn CodeWhisperer page
                    ]
                }
            }
        }

        const children = _getChildren()

        // Add 'Sign Out' to quick pick if user is connected
        if (AuthUtil.instance.isConnected() && type === 'item' && !hasVendedIamCredentials()) {
            return [...children, { kind: vscode.QuickPickItemKind.Separator, data: 'separator' }, createSignout('item')]
        }

        return children
    }

    /**
     * HACK: Since this is assumed to be an immediate child of the
     * root, we return undefined.
     *
     * TODO: Look to have a base root class to extend so we do not
     * need to implement this here.
     * @returns
     */
    getParent(): TreeNode<unknown> | undefined {
        return undefined
    }

    public updateShowFreeTierLimitReachedNode(show: boolean) {
        this._showFreeTierLimitReachedNode = show
    }
}

export const codewhispererNode = new CodeWhispererNode()
export const refreshCodeWhisperer = Commands.register(
    { id: 'aws.codeWhisperer.refresh', logging: false },
    (showFreeTierLimitNode = false) => {
        codewhispererNode.updateShowFreeTierLimitReachedNode(showFreeTierLimitNode)
        codewhispererNode.refresh()
    }
)

export const refreshCodeWhispererRootNode = Commands.register(
    { id: 'aws.codeWhisperer.refreshRootNode', logging: false },
    () => {
        codewhispererNode.refreshRootNode()
    }
)
