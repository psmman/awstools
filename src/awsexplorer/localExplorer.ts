/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { ResourceTreeDataProvider, TreeNode } from '../shared/treeview/resourceTreeDataProvider'
import { isCloud9 } from '../shared/extensionUtilities'

export interface RootNode<T = unknown> extends TreeNode<T> {
    /**
     * An optional event to signal that this node's visibility has changed.
     */
    readonly onDidChangeVisibility?: vscode.Event<void>

    /**
     * Determines whether this node should be rendered in the tree view.
     *
     * If not implemented, it is assumed that the node is always visible.
     */
    canShow?(): Promise<boolean> | boolean
}

function throttle<T>(cb: () => T | Promise<T>, delay: number): () => Promise<T> {
    let timer: NodeJS.Timeout | undefined
    let promise: Promise<T> | undefined

    return () => {
        timer?.refresh()

        return (promise ??= new Promise<T>((resolve, reject) => {
            timer = setTimeout(async () => {
                timer = promise = undefined
                try {
                    resolve(await cb())
                } catch (err) {
                    reject(err)
                }
            }, delay)
        }))
    }
}

/**
 * The 'local' explorer is represented as 'Developer Tools' in the UI. We use a different name within
 * source code to differentiate between _Toolkit developers_ and _Toolkit users_.
 *
 * Components placed under this view do not strictly need to be 'local'. They just need to place greater
 * emphasis on the developer's local development environment.
 */
export function createLocalExplorerView(rootNodes: RootNode[]): vscode.TreeView<TreeNode> {
    const treeDataProvider = new ResourceTreeDataProvider({ getChildren: () => getChildren(rootNodes) })
    const view = vscode.window.createTreeView('aws.developerTools', { treeDataProvider })

    rootNodes.forEach(node => node.onDidChangeVisibility?.(() => treeDataProvider.refresh(node)))

    // Cloud9 will only refresh when refreshing the entire tree
    if (isCloud9()) {
        rootNodes.forEach(node => {
            const refresh = throttle(() => treeDataProvider.refresh(node), 10)
            node.onDidChangeTreeItem?.(() => refresh())
            node.onDidChangeChildren?.(() => refresh())
        })
    }

    return view
}

async function getChildren(roots: RootNode[]) {
    const nodes: TreeNode[] = []

    for (const node of roots) {
        if (!node.canShow || (await node.canShow())) {
            nodes.push(node)
        }
    }

    return nodes
}
