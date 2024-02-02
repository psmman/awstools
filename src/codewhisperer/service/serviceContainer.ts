/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthUtil } from '../util/authUtil'
import { EditorGutterController } from '../views/annotations/editorGutterController'
import { LineAnnotationController } from '../views/annotations/lineAnnotationController'
import { LineTracker } from '../views/annotations/lineTracker'

export class Container {
    static #instance: Container | undefined

    static create(authProvider: AuthUtil): Container {
        if (Container.#instance) {
            throw new Error('Container already exists')
        }

        Container.#instance = new Container(authProvider)
        return Container.#instance
    }

    static get instance(): Container {
        return Container.#instance ?? Container.create(AuthUtil.instance)
    }

    readonly _lineTracker: LineTracker
    readonly _lineAnnotationController: LineAnnotationController
    readonly _editorGutterController: EditorGutterController

    constructor(private readonly auth: AuthUtil) {
        this._lineTracker = new LineTracker()
        this._lineAnnotationController = new LineAnnotationController(this._lineTracker, this.auth)
        this._editorGutterController = new EditorGutterController(this._lineTracker, this.auth)
    }

    ready() {
        this._lineTracker.ready()
    }
}
