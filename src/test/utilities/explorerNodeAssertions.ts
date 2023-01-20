/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import { AWSTreeNodeBase } from '../../shared/treeview/nodes/awsTreeNodeBase'
import { PlaceholderNode } from '../../shared/treeview/nodes/placeholderNode'

export function assertNodeListOnlyHasErrorNode(nodes: AWSTreeNodeBase[]) {
    assert(nodes !== undefined)
    assert.strictEqual(nodes.length, 1, 'Unexpected node count')
    assert.strictEqual(nodes[0].contextValue, 'awsErrorNode', 'Expected ErrorNode in the list')
}

// eslint-disable-next-line id-length
export function assertNodeListOnlyHasPlaceholderNode(nodes: AWSTreeNodeBase[]) {
    assert(nodes !== undefined)
    assert.strictEqual(nodes.length, 1, 'Unexpected node count')
    assert.ok(nodes[0] instanceof PlaceholderNode, 'Expected placeholder node in the list')
}
