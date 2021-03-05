/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as lolex from 'lolex'
import * as timeoutUtils from '../../../shared/utilities/timeoutUtils'

describe('timeoutUtils', async () => {
    let clock: lolex.InstalledClock

    before(() => {
        clock = lolex.install()
    })

    after(() => {
        clock.uninstall()
    })

    describe('Timeout', async () => {
        it('returns > 0 if the timer is still active', async () => {
            const timerLengthMs = 100
            const longTimer = new timeoutUtils.Timeout(timerLengthMs)
            clock.tick(timerLengthMs / 2)
            assert.strictEqual(longTimer.remainingTime > 0, true)
            // kill the timer to not mess with other tests
            longTimer.killTimer()
        })

        it('returns 0 if timer is expired', async () => {
            const timerLengthMs = 10
            const shortTimer = new timeoutUtils.Timeout(timerLengthMs)
            clock.tick(timerLengthMs + 1)
            setTimeout(() => {
                assert.strictEqual(shortTimer.remainingTime, 0)
            }, 10)
        })

        it('returns a Promise if a timer is active', async () => {
            const longTimer = new timeoutUtils.Timeout(300)
            assert.strictEqual(longTimer.timer instanceof Promise, true)
            // kill the timer to not mess with other tests
            longTimer.killTimer()
        })

        it('timer object rejects if a timer is expired', async () => {
            const timerLengthMs = 10
            const shortTimer = new timeoutUtils.Timeout(timerLengthMs)
            clock.tick(timerLengthMs + 1)
            await shortTimer.timer.catch(value => {
                assert.strictEqual(value, undefined)
            })
        })

        it('successfully kills active timers', async () => {
            const longTimer = new timeoutUtils.Timeout(300)
            // make sure this is an active Promise
            assert.strictEqual(longTimer.timer instanceof Promise, true)
            longTimer.killTimer()
            try {
                // make sure the promise was resolved
                await longTimer.timer
            } catch {
                // if the timer was not killed, promise will reject after 300 ms and test should fail.
                assert.fail('the promise was not killed!')
            }
        })

        it('correctly reports an elapsed time', async () => {
            const checkTimerMs = 50
            const longTimer = new timeoutUtils.Timeout(checkTimerMs * 6)

            // Simulate a small amount of time, then measure elapsed time
            clock.tick(checkTimerMs)

            assert.strictEqual(longTimer.elapsedTime, checkTimerMs)

            // kill the timer to not mess with other tests
            longTimer.killTimer()
        })

        it('Correctly reports elapsed time with refresh', async () => {
            const longTimer = new timeoutUtils.Timeout(10)
            clock.tick(5)
            longTimer.refresh()
            clock.tick(5)
            assert.strictEqual(longTimer.elapsedTime, 10)
            assert.strictEqual(longTimer.remainingTime, 5)

            // kill the timer to not mess with other tests
            longTimer.killTimer()
        })

        it('Refresh pushes back the start time', async () => {
            const longTimer = new timeoutUtils.Timeout(10)
            clock.tick(5)
            longTimer.refresh()
            assert.strictEqual(longTimer.remainingTime, 10)

            // kill the timer to not mess with other tests
            longTimer.killTimer()
        })
    })

    describe('waitUntil', async () => {
        const testSettings = {callCounter: 0, callGoal: 0, functionDelay: 10}

        async function testFunction(): Promise<number | undefined> {
            if (++testSettings.callCounter == testSettings.callGoal) {
                return testSettings.callCounter
            } else {
                return undefined
            }
        }

        async function slowTestFunction(): Promise<number | undefined> {
            await new Promise(r => setTimeout(r, testSettings.functionDelay))
            return testFunction()
        }

        before(() => {
            clock.uninstall()
        })

        after(() => {
            clock = lolex.install()
        })

        beforeEach(() => {
            testSettings.callCounter = 0
            testSettings.functionDelay = 10
        })

        it('returns value after multiple function calls', async () => {
            testSettings.callGoal = 4
            const returnValue: number | undefined = await timeoutUtils.waitUntil(testFunction, { timeout: 60, interval: 10 })
            assert.strictEqual(returnValue, testSettings.callGoal)
        })

        it('timeout before function returns defined value', async () => {
            testSettings.callGoal = 7
            const returnValue: number | undefined = await timeoutUtils.waitUntil(testFunction, { timeout: 30, interval: 10 })
            assert.strictEqual(returnValue, undefined)
        })

        it('timeout from slow function calls', async () => {
            testSettings.callGoal = 10
            const returnValue: number | undefined = await timeoutUtils.waitUntil(slowTestFunction, { timeout: 50, interval: 10 })
            assert.strictEqual(returnValue, undefined)
        })

        it('returns value with after multiple calls and function delay ', async () => {
            testSettings.callGoal = 3
            testSettings.functionDelay = 5
            const returnValue: number | undefined = await timeoutUtils.waitUntil(slowTestFunction, { timeout: 60, interval: 5 })
            assert.strictEqual(returnValue, testSettings.callGoal)
        })
    })
})
