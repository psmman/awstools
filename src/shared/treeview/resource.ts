/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as localizedText from '../localizedText'
import { UnknownError } from '../errors'
import { AsyncCollection, isAsyncCollection } from '../utilities/asyncCollection'
import { isAsyncIterable } from '../utilities/collectionUtils'
import { once } from '../utilities/functionUtils'
import { Commands } from '../vscode/commands2'
import { TreeNode } from './resourceTreeDataProvider'
import { createErrorItem, createPlaceholderItem } from './utils'

export interface Resource {
    /**
     * The identifier associated with the resource.
     *
     * This should be considered _globally_ unique, trancending conventional references. Consumers of
     * the interface can and most likely will treat this identifier as canonical.
     */
    readonly id: string
}

interface SimpleResourceProvider<T extends Resource = Resource> {
    readonly paginated?: false
    readonly onDidChange?: vscode.Event<T | void>
    listResources(): Promise<T[]> | T[]
}

interface PaginatedResourceProvider<T extends Resource = Resource> {
    readonly paginated: true
    readonly onDidChange?: vscode.Event<T | void>
    listResources(): AsyncCollection<T | T[]>
}

export type ResourceProvider<T extends Resource> = SimpleResourceProvider<T> | PaginatedResourceProvider<T>

export class PageLoader<T> {
    private isDone = false
    private loadPromise: Promise<T[] | undefined> | undefined
    private iterator?: AsyncIterator<T | T[], T | T[] | undefined | void>
    private readonly pages: T[][] = []

    public constructor(private readonly iterable: AsyncIterable<T | T[]>) {}

    public get done(): boolean {
        return this.isDone
    }

    public get loading(): boolean {
        return this.loadPromise !== undefined
    }

    public async get(): Promise<T[][]> {
        if (this.pages.length === 0) {
            return this.load().then(() => this.pages)
        }

        await this.loadPromise

        return this.pages
    }

    public async load(): Promise<T[] | undefined> {
        return (this.loadPromise ??= this.next().then(() => (this.loadPromise = undefined)))
    }

    public dispose(): void {
        this.pages.length = 0
        this.isDone = true
        this.iterator?.return?.()
    }

    private async next(): Promise<T[] | undefined> {
        const iterator = (this.iterator ??= this.getIterator())
        const { value, done } = await iterator.next()

        this.isDone = done ?? this.isDone

        if (value !== undefined) {
            const page = !Array.isArray(value) ? [value] : value
            this.pages.push(page)

            return page
        }
    }

    private getIterator() {
        if (isAsyncCollection(this.iterable)) {
            return this.iterable.iterator()
        } else {
            return this.iterable[Symbol.asyncIterator]()
        }
    }
}

type LoadMoreable<T> = {
    loadMore(resource?: T): Promise<void> | void
}

const loadMore = <T>(controller: LoadMoreable<T>, target?: T) => controller.loadMore(target)

export const loadMoreCommand = Commands.instance.register('_aws.resources.loadMore', loadMore)

interface TreeNodeOptions<T> {
    readonly placeholder?: string | TreeNode
    readonly childrenProvider?: ResourceProvider<TreeNode<T>>
    readonly onError?: (error: Error) => TreeNode
    sort?(a: TreeNode<T>, b: TreeNode<T>): number
}

type TreeResource<T> = Pick<TreeNode<T>, 'id' | 'getTreeItem' | 'onDidChangeTreeItem'>

export class ResourceTreeNode<T extends TreeResource<unknown>, U = never> implements TreeNode<T> {
    public readonly id = this.resource.id
    public readonly onDidChangeTreeItem = this.resource.onDidChangeTreeItem
    private readonly disposables: vscode.Disposable[] = []
    private readonly getChangedEmitter = once(this.createEmitter.bind(this))

    private loader?: PageLoader<TreeNode<U>>

    public constructor(public readonly resource: T, private readonly options?: TreeNodeOptions<U>) {}

    public get onDidChangeChildren() {
        if (this.options?.childrenProvider?.onDidChange || this.options?.childrenProvider?.paginated) {
            return this.getChangedEmitter().event
        }
    }

    public getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem> {
        const collapsibleState =
            this.options?.childrenProvider !== undefined
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None

        // The two branches are for tree shim optimizations
        const item = this.resource.getTreeItem()
        if (item instanceof Promise) {
            return item.then(i => {
                i.collapsibleState = collapsibleState
                return i
            })
        }
        item.collapsibleState = collapsibleState

        return item
    }

    public async getChildren(): Promise<TreeNode<U>[] | [...TreeNode<U>[], TreeNode]> {
        if (!this.options?.childrenProvider) {
            return []
        }

        const { placeholder, childrenProvider, onError } = this.options
        const children = this.fromProvider(childrenProvider)
        const [succeeded, result] = await handleError(children, onError ?? createErrorItem)

        if (result.length === 0 && placeholder !== undefined) {
            return [typeof placeholder === 'string' ? createPlaceholderItem(placeholder) : placeholder]
        }

        if (succeeded) {
            if (this.options.sort) {
                result.sort(this.options.sort.bind(this.options))
            }

            if (this.loader && !this.loader.done) {
                return this.withLoadMoreNode(this.loader, result)
            }
        }

        return result
    }

    public dispose(): void {
        this.loader?.dispose()
        vscode.Disposable.from(...this.disposables).dispose()
    }

    private refresh(): void {
        this.loader?.dispose()
        this.loader = undefined
        this.getChangedEmitter().fire()
    }

    private async fromProvider(provider: ResourceProvider<TreeNode<U>>): Promise<TreeNode<U>[]> {
        if (this.loader) {
            return this.loadFrom(this.loader)
        }

        const children = provider.listResources()
        if (isAsyncIterable(children)) {
            const loader = (this.loader ??= new PageLoader(children))

            return this.loadFrom(loader)
        }

        return children
    }

    private async loadFrom(loader: PageLoader<TreeNode<U>>): Promise<TreeNode<U>[]> {
        const pages = await loader.get()
        const merged = pages.reduce((a, b) => a.concat(b), [])

        return merged
    }

    private withLoadMoreNode(loader: PageLoader<TreeNode<U>>, result: TreeNode<U>[]): [...typeof result, TreeNode] {
        // TODO: optimize this by making `loadMore` apart of the `ResourceTreeNode` prototype?
        // but then we can't make the method private :/
        const controller = {
            loadMore: () => {
                loader.load().finally(() => this.getChangedEmitter().fire())
            },
        }
        const loadMoreNode = loadMoreCommand
            .build(controller, loader)
            .asTreeNode({ label: `${localizedText.loadMore}...` })

        return [...result, loadMoreNode]
    }

    private createEmitter(): vscode.EventEmitter<void> {
        const emitter = new vscode.EventEmitter<void>()
        const provider = this.options?.childrenProvider

        if (provider?.onDidChange) {
            this.disposables.push(provider.onDidChange(() => this.refresh()))
        }

        this.disposables.push(emitter)
        return emitter
    }
}

type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>)
type ResultPair<T, U> = [succeeded: true, result: T] | [succeeded: false, result: U]

async function handleError<T, E>(
    children: Resolvable<T[]>,
    createErrorResource?: (error: Error) => E
): Promise<ResultPair<T[], [E]>> {
    try {
        const result = await (typeof children === 'function' ? children() : children)

        return [true, result]
    } catch (error) {
        if (!createErrorResource) {
            throw error
        }

        return [false, [createErrorResource(UnknownError.cast(error))]]
    }
}
