/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { EcsClient } from '../../shared/clients/ecsClient'
import globals from '../../shared/extensionGlobals'

import { AWSTreeNodeBase } from '../../shared/treeview/nodes/awsTreeNodeBase'
import { EcsServiceNode } from './ecsServiceNode'

const CONTEXT_EXEC_ENABLED = 'awsEcsContainerNodeExecEnabled'
const CONTEXT_EXEC_DISABLED = 'awsEcsContainerNodeExecDisabled'

export class EcsContainerNode extends AWSTreeNodeBase {
    public constructor(
        public readonly containerName: string,
        public readonly ecs: EcsClient,
        public readonly parent: EcsServiceNode,
        public readonly taskRoleArn: string | undefined
    ) {
        super(containerName)
        this.tooltip = containerName
        this.contextValue = this.parent.service.enableExecuteCommand ? CONTEXT_EXEC_ENABLED : CONTEXT_EXEC_DISABLED

        this.iconPath = {
            dark: vscode.Uri.file(globals.iconPaths.dark.container),
            light: vscode.Uri.file(globals.iconPaths.light.container),
        }
    }

    public listTasks() {
        return this.ecs.listTasks(this.parent.service.clusterArn!, this.parent.service.serviceName!)
    }

    public describeTasks(tasks: string[]) {
        return this.ecs.describeTasks(this.parent.service.clusterArn!, tasks)
    }
}
