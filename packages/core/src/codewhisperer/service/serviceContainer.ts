/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthUtil } from '../util/authUtil'
import { activeStateController } from '../views/activeStateController'
import { LineAnnotationController } from '../views/lineAnnotationController'
import { LineTracker } from '../tracker/lineTracker'

/**
 * Container for CodeWhisperer sub-components
 * Please utilize this container class as the bridge to access other components to avoid create singleton objects when it's not necessary.
 * Example:
 * class SubComponent {
 *      constructor(private readonly container: Container) {}
 *
 *      public doSomething() {
 *          const isConnected = this.container.authProvider.isConnected()
 *          this.anotherComponent.update(isConnected)
 *      }
 * }
 */
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
        return (Container.#instance ??= new Container(AuthUtil.instance))
    }

    readonly _lineTracker: LineTracker
    readonly _lineAnnotationController: LineAnnotationController
    readonly _editorGutterController: activeStateController

    protected constructor(readonly auth: AuthUtil) {
        this._lineTracker = new LineTracker()
        this._lineAnnotationController = new LineAnnotationController(this)
        this._editorGutterController = new activeStateController(this)
    }

    ready() {
        this._lineTracker.ready()
    }
}
