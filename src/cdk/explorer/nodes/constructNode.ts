/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { AWSTreeNodeBase } from '../../../shared/treeview/nodes/awsTreeNodeBase'
import { cdk } from '../../globals'
import { CfnResourceKeys, ConstructTreeEntity } from '../tree/types'

/**
 * Represents a CDK construct
 */
export class ConstructNode extends AWSTreeNodeBase {
    private readonly type: string

    get tooltip(): string {
        return this.type || this.construct.path
    }

    get id(): string {
        return this.construct.path
    }

    public constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly construct: ConstructTreeEntity
    ) {
        super(construct.id, collapsibleState)
        this.contextValue = 'awsCdkNode'

        this.type = construct.attributes ? (construct.attributes[CfnResourceKeys.TYPE] as string) : ''
        // TODO move icon logic to global utility
        if (this.type) {
            this.iconPath = {
                dark: vscode.Uri.file(cdk.iconPaths.dark.cloudFormation),
                light: vscode.Uri.file(cdk.iconPaths.light.cloudFormation)
            }
        } else {
            this.iconPath = {
                dark: vscode.Uri.file(cdk.iconPaths.dark.cdk),
                light: vscode.Uri.file(cdk.iconPaths.light.cdk)
            }
        }
    }

    public async getChildren(): Promise<(ConstructNode)[]> {
        const entities = []

        if (!this.construct.children) {
            return []
        }

        for (const key of Object.keys(this.construct.children)) {
            const child = this.construct.children[key] as ConstructTreeEntity

            // TODO tree should not be encoded in the CDK tree spec and should be removed
            if (child.id !== 'Tree' && child.path !== 'Tree') {
                const cfnResourceType = child.attributes && (child.attributes[CfnResourceKeys.TYPE] as string)
                entities.push(
                    new ConstructNode(
                        child.id === 'Resource' && cfnResourceType ? `${child.id} (${cfnResourceType})` : child.id,
                        child.children || child.attributes
                            ? vscode.TreeItemCollapsibleState.Collapsed
                            : vscode.TreeItemCollapsibleState.None,
                        child
                    )
                )
            }
        }

        return entities
    }
}
