/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import { ToolkitError } from '../../../shared/errors'
import { TelemetrySpan, TelemetryTracer } from '../../../shared/telemetry/spans'
import { MetricName, MetricShapes } from '../../../shared/telemetry/telemetry'
import { assertTelemetry, getMetrics, installFakeClock } from '../../testUtil'
import { selectFrom } from '../../../shared/utilities/tsUtils'

describe('TelemetrySpan', function () {
    let clock: ReturnType<typeof installFakeClock>

    beforeEach(function () {
        clock = installFakeClock()
    })

    afterEach(function () {
        clock.uninstall()
    })

    it('removes passive and value from the metadata', function () {
        new TelemetrySpan('foo').emit({ passive: false, value: 100, reason: 'bar' })

        assert.deepStrictEqual(getMetrics('foo' as MetricName)[0], { reason: 'bar' })
    })

    it('records duration if a start time is available', function () {
        const span = new TelemetrySpan('foo').start()
        clock.tick(100)
        span.stop()

        assert.deepStrictEqual(getMetrics('foo' as MetricName)[0], {
            result: 'Succeeded',
            duration: '100',
        })
    })

    it('records failure reason if available', function () {
        new TelemetrySpan('foo').start().stop(new ToolkitError('', { code: 'Foo' }))

        assert.deepStrictEqual(getMetrics('foo' as MetricName)[0], {
            result: 'Failed',
            reason: 'Foo',
            duration: '0',
        })
    })

    it('reports missing required fields', function () {
        new TelemetrySpan('vscode_executeCommand').emit()

        assert.deepStrictEqual(getMetrics('vscode_executeCommand')[0], {
            missingFields: String(['command']),
        })
    })

    it('can create clones that do not copy the start time', function () {
        const span = new TelemetrySpan('foo').record({ reason: 'bar' }).start()
        clock.tick(100)
        span.clone().emit({ result: 'Failed' })
        span.stop()

        const metrics = getMetrics('foo' as MetricName)
        assert.deepStrictEqual(metrics[0], { result: 'Failed', reason: 'bar' })
        assert.deepStrictEqual(metrics[1], { result: 'Succeeded', duration: '100' })
    })
})

describe('TelemetryTracer', function () {
    let tracer: TelemetryTracer
    const metricName = 'test_metric' as MetricName

    beforeEach(function () {
        tracer = new TelemetryTracer()
    })

    describe('record', function () {
        it('writes to all existing spans in the current context', function () {
            tracer.apigateway_copyUrl.run(() => {
                tracer.run(metricName, () => tracer.record({ source: 'bar' }))
                tracer.spans[0]?.emit()
            })

            assertTelemetry(metricName, { result: 'Succeeded', source: 'bar' })
            assertTelemetry('apigateway_copyUrl', { source: 'bar' } as MetricShapes['apigateway_copyUrl'])
        })

        it('writes to all new spans in the current context', function () {
            tracer.apigateway_copyUrl.run(() => {
                tracer.record({ source: 'bar' })
                tracer.run(metricName, () => {})
            })

            assertTelemetry(metricName, { result: 'Succeeded', source: 'bar' })
            assertTelemetry('apigateway_copyUrl', { result: 'Succeeded', source: 'bar' } as any)
        })

        it('does not propagate state outside of the execution', function () {
            tracer.apigateway_copyUrl.run(() => tracer.record({ source: 'bar' }))
            tracer.run(metricName, () => {})

            assertTelemetry(metricName, { result: 'Succeeded' })
        })

        it('does not clobber subsequent writes to individual spans', function () {
            tracer.run(metricName, span => {
                tracer.record({ source: 'bar' })
                span.record({ source: 'foo' })
            })

            assertTelemetry(metricName, { result: 'Succeeded', source: 'foo' })
        })

        it('applies to next immediate span when called outside of a context', function () {
            tracer.record({ source: 'bar' })
            tracer.run(metricName, () => {})
            tracer.apigateway_copyUrl.run(() => {})

            assertTelemetry(metricName, { result: 'Succeeded', source: 'bar' })
            assertTelemetry('apigateway_copyUrl', { result: 'Succeeded' } as any)
        })
    })

    describe('instrument', function () {
        async function assertPositive(n: number): Promise<number> {
            if (n <= 0) {
                throw new Error()
            }

            return n
        }

        it('can instrument a function', async function () {
            const fn = tracer.instrument(metricName, assertPositive)

            assert.strictEqual(await fn(1), 1)
            assertTelemetry(metricName, { result: 'Succeeded' })
        })

        it('can instrument a function that fails', async function () {
            const fn = tracer.instrument(metricName, assertPositive)

            await assert.rejects(() => fn(-1))
            assertTelemetry(metricName, { result: 'Failed', reason: 'Error' })
        })
    })

    describe('metrics', function () {
        it('does not change the context when emitting', function () {
            tracer.vscode_executeCommand.emit({ command: 'foo', debounceCount: 1 })

            assert.strictEqual(tracer.activeSpan, undefined)
            assert.strictEqual(tracer.spans.length, 0)
        })

        it('does not change the active span when using a different span', function () {
            tracer.run(metricName, span => {
                tracer.vscode_executeCommand.record({ command: 'foo', debounceCount: 1 })
                assert.strictEqual(tracer.activeSpan, span)
            })

            assertTelemetry(metricName, { result: 'Succeeded' })
            assert.strictEqual(tracer.activeSpan, undefined)
        })
    })

    describe('increment', function () {
        it('starts at 0 for uninitialized fields', function () {
            tracer.vscode_executeCommand.run(span => {
                span.record({ command: 'foo' })
                span.increment({ debounceCount: 1 })
                span.increment({ debounceCount: 1 })
            })

            assertTelemetry('vscode_executeCommand', {
                result: 'Succeeded',
                command: 'foo',
                debounceCount: 2,
            })
        })

        it('applies to spans independently from one another', function () {
            tracer.vscode_executeCommand.run(span => {
                span.record({ debounceCount: 1 })
                span.increment({ debounceCount: 1 })
                tracer.vscode_executeCommand.run(span => {
                    span.increment({ debounceCount: 10 })
                })
            })

            const metrics = getMetrics('vscode_executeCommand').map(m => selectFrom(m, 'debounceCount'))
            assert.deepStrictEqual(metrics[0], { debounceCount: '10' })
            assert.deepStrictEqual(metrics[1], { debounceCount: '2' })
        })
    })

    describe('run', function () {
        it('returns the result of the function', function () {
            const result = tracer.run(metricName, () => 'foo')

            assert.strictEqual(result, 'foo')
        })

        it('sets the active span', function () {
            const checkSpan = () => tracer.run(metricName, span => assert.strictEqual(tracer.activeSpan, span))

            assert.doesNotThrow(checkSpan)
        })

        it('uses a span over a telemetry metric', function () {
            tracer.run(metricName, span => span.record({ source: 'bar' }))

            assertTelemetry(metricName, { result: 'Succeeded', source: 'bar' })
        })

        describe('nested run', function () {
            const nestedName = 'nested_metric' as MetricName

            it('can record metadata in nested spans', function () {
                tracer.run(metricName, span1 => {
                    span1.record({ source: 'bar' })

                    tracer.run(nestedName, span2 => {
                        span1.record({ attempts: 1 })
                        span2.record({ source: 'foo' })
                    })
                })

                assertTelemetry(metricName, { result: 'Succeeded', source: 'bar', attempts: 1 })
                assertTelemetry(nestedName, { result: 'Succeeded', source: 'foo' })
            })

            it('removes spans when exiting an execution context', function () {
                tracer.run(metricName, () => {
                    tracer.run(nestedName, () => {
                        assert.strictEqual(tracer.spans.length, 2)
                    })

                    assert.strictEqual(tracer.spans.length, 1)
                })
            })

            it('adds spans during a nested execution, closing them when after', function () {
                tracer.run(metricName, () => {
                    tracer.run(nestedName, () => assert.strictEqual(tracer.spans.length, 2))
                    tracer.run(nestedName, () => assert.strictEqual(tracer.spans.length, 2))
                    assert.strictEqual(tracer.spans.length, 1)
                })

                assert.strictEqual(tracer.spans.length, 0)
            })

            it('supports nesting the same event name', function () {
                tracer.run(metricName, () => {
                    tracer.run(metricName, () => {
                        assert.strictEqual(tracer.spans.length, 2)
                        assert.ok(tracer.spans.every(s => s.name === metricName))
                    })
                })
            })
        })
    })
})
