/**
 * XMLHttpRequest override class.
 * Inspired by https://github.com/marvinhagemeister/xhr-mocklet.
 */
import { until } from '@open-draft/until'
import {
  Headers,
  stringToHeaders,
  objectToHeaders,
  headersToString,
} from 'headers-utils'
import { IsomorphicRequest, Observer, Resolver } from '../../createInterceptor'
import { parseJson } from '../../utils/parseJson'
import { bufferFrom } from './utils/bufferFrom'
import { createEvent } from './utils/createEvent'

const createDebug = require('debug')

type XMLHttpRequestEventHandler = (
  this: XMLHttpRequest,
  event: Event | ProgressEvent<any>
) => void

interface XMLHttpRequestEvent<EventMap extends any> {
  name: keyof EventMap
  listener: XMLHttpRequestEventHandler
}

interface CreateXMLHttpRequestOverrideOptions {
  pureXMLHttpRequest: typeof window.XMLHttpRequest
  observer: Observer
  resolver: Resolver
}

interface InternalXMLHttpRequestEventTargetEventMap
  extends XMLHttpRequestEventTargetEventMap {
  readystatechange: Event
}

export const createXMLHttpRequestOverride = (
  options: CreateXMLHttpRequestOverrideOptions
) => {
  const { pureXMLHttpRequest, observer, resolver } = options
  let debug = createDebug('XHR')

  return class XMLHttpRequestOverride implements XMLHttpRequest {
    _requestHeaders: Headers
    _responseHeaders: Headers

    // Collection of events modified by `addEventListener`/`removeEventListener` calls.
    _events: XMLHttpRequestEvent<InternalXMLHttpRequestEventTargetEventMap>[] = []

    /* Request state */
    public static readonly UNSENT = 0
    public static readonly OPENED = 1
    public static readonly HEADERS_RECEIVED = 2
    public static readonly LOADING = 3
    public static readonly DONE = 4
    public readonly UNSENT = 0
    public readonly OPENED = 1
    public readonly HEADERS_RECEIVED = 2
    public readonly LOADING = 3
    public readonly DONE = 4

    /* Custom public properties */
    public method: string
    public url: string

    /* XHR public properties */
    public withCredentials: boolean
    public status: number
    public statusText: string
    public user?: string
    public password?: string
    public data: string
    public async?: boolean
    public response: any
    public responseText: string
    public responseType: XMLHttpRequestResponseType
    public responseXML: Document | null
    public responseURL: string
    public upload: XMLHttpRequestUpload
    public readyState: number
    public onreadystatechange: (
      this: XMLHttpRequest,
      ev: Event
    ) => any = null as any
    public timeout: number

    /* Events */
    public onabort: (
      this: XMLHttpRequestEventTarget,
      event: ProgressEvent
    ) => any = null as any
    public onerror: (
      this: XMLHttpRequestEventTarget,
      event: Event
    ) => any = null as any
    public onload: (
      this: XMLHttpRequestEventTarget,
      event: ProgressEvent
    ) => any = null as any
    public onloadend: (
      this: XMLHttpRequestEventTarget,
      event: ProgressEvent
    ) => any = null as any
    public onloadstart: (
      this: XMLHttpRequestEventTarget,
      event: ProgressEvent
    ) => any = null as any
    public onprogress: (
      this: XMLHttpRequestEventTarget,
      event: ProgressEvent
    ) => any = null as any
    public ontimeout: (
      this: XMLHttpRequestEventTarget,
      event: ProgressEvent
    ) => any = null as any

    constructor() {
      this.url = ''
      this.method = 'GET'
      this.readyState = this.UNSENT
      this.withCredentials = false
      this.status = 200
      this.statusText = 'OK'
      this.data = ''
      this.response = ''
      this.responseType = 'text'
      this.responseText = ''
      this.responseXML = null
      this.responseURL = ''
      this.upload = null as any
      this.timeout = 0

      this._requestHeaders = new Headers()
      this._responseHeaders = new Headers()
    }

    setReadyState(nextState: number): void {
      if (nextState === this.readyState) {
        return
      }

      debug('readyState change %d -> %d', this.readyState, nextState)
      this.readyState = nextState

      if (nextState !== this.UNSENT) {
        debug('triggerring readystate change...')
        this.trigger('readystatechange')
      }
    }

    /**
     * Triggers both direct callback and attached event listeners
     * for the given event.
     */
    trigger<
      K extends keyof (XMLHttpRequestEventTargetEventMap & {
        readystatechange: ProgressEvent<XMLHttpRequestEventTarget>
      })
    >(eventName: K, options?: ProgressEventInit) {
      debug('trigger "%s" (%d)', eventName, this.readyState)
      debug('resolve listener for event "%s"', eventName)

      // @ts-expect-error XMLHttpRequest class has no index signature.
      const callback = this[`on${eventName}`] as XMLHttpRequestEventHandler
      callback?.call(this, createEvent(this, eventName, options))

      for (const event of this._events) {
        if (event.name === eventName) {
          debug(
            'calling mock event listener "%s" (%d)',
            eventName,
            this.readyState
          )
          event.listener.call(this, createEvent(this, eventName, options))
        }
      }

      return this
    }

    reset() {
      debug('reset')

      this.setReadyState(this.UNSENT)
      this.status = 200
      this.statusText = 'OK'
      this.data = ''
      this.response = null as any
      this.responseText = null as any
      this.responseXML = null as any

      this._requestHeaders = new Headers()
      this._responseHeaders = new Headers()
    }

    public async open(
      method: string,
      url: string,
      async: boolean = true,
      user?: string,
      password?: string
    ) {
      debug = createDebug(`XHR ${method} ${url}`)
      debug('open', { method, url, async, user, password })

      this.reset()
      this.setReadyState(this.OPENED)

      if (typeof url === 'undefined') {
        this.url = method
        this.method = 'GET'
      } else {
        this.url = url
        this.method = method
        this.async = async
        this.user = user
        this.password = password
      }
    }

    public send(data?: string) {
      debug('send %s %s', this.method, this.url)

      this.data = data || ''

      let url: URL

      try {
        url = new URL(this.url)
      } catch (error) {
        // Assume a relative URL, if construction of a new `URL` instance fails.
        // Since `XMLHttpRequest` always executed in a DOM-like environment,
        // resolve the relative request URL against the current window location.
        url = new URL(this.url, window.location.href)
      }

      debug('request headers', this._requestHeaders)

      // Create an intercepted request instance exposed to the request intercepting middleware.
      const isoRequest: IsomorphicRequest = {
        url,
        method: this.method,
        body: this.data,
        headers: this._requestHeaders,
      }

      debug('awaiting mocked response...')

      Promise.resolve(until(async () => resolver(isoRequest, this))).then(
        ([middlewareException, mockedResponse]) => {
          // When the request middleware throws an exception, error the request.
          // This cancels the request and is similar to a network error.
          if (middlewareException) {
            debug(
              'middleware function threw an exception!',
              middlewareException
            )

            // No way to propagate the actual error message.
            this.trigger('error')
            this.abort()

            return
          }

          // Return a mocked response, if provided in the middleware.
          if (mockedResponse) {
            debug('received mocked response', mockedResponse)

            // Trigger a loadstart event to indicate the initialization of the fetch.
            this.trigger('loadstart')

            this.status = mockedResponse.status || 200
            this.statusText = mockedResponse.statusText || 'OK'
            this._responseHeaders = mockedResponse.headers
              ? objectToHeaders(mockedResponse.headers)
              : new Headers()

            debug('set response status', this.status, this.statusText)
            debug('set response headers', this._responseHeaders)

            // Mark that response headers has been received
            // and trigger a ready state event to reflect received headers
            // in a custom `onreadystatechange` callback.
            this.setReadyState(this.HEADERS_RECEIVED)

            debug('response type', this.responseType)
            this.response = this.getResponseBody(mockedResponse.body)
            this.responseText = mockedResponse.body || ''

            debug('set response body', this.response)

            if (mockedResponse.body && this.response) {
              this.setReadyState(this.LOADING)

              // Presense of the mocked response implies a response body (not null).
              // Presense of the coerced `this.response` implies the mocked body is valid.
              const bodyBuffer = bufferFrom(mockedResponse.body)

              // Trigger a progress event based on the mocked response body.
              this.trigger('progress', {
                loaded: bodyBuffer.length,
                total: bodyBuffer.length,
              })
            }

            /**
             * Explicitly mark the request as done so its response never hangs.
             * @see https://github.com/mswjs/node-request-interceptor/issues/13
             */
            this.setReadyState(this.DONE)

            // Trigger a load event to indicate the fetch has succeeded.
            this.trigger('load')
            // Trigger a loadend event to indicate the fetch has completed.
            this.trigger('loadend')

            observer.emit('response', isoRequest, {
              status: this.status,
              statusText: this.statusText,
              headers: objectToHeaders(mockedResponse.headers || {}),
              body: mockedResponse.body,
            })
          } else {
            debug('no mocked response received!')

            // Perform an original request, when the request middleware returned no mocked response.
            const originalRequest = new pureXMLHttpRequest()

            debug('opening an original request %s %s', this.method, this.url)
            originalRequest.open(
              this.method,
              this.url,
              this.async ?? true,
              this.user,
              this.password
            )

            // Reflect a successful state of the original request
            // on the patched instance.
            originalRequest.addEventListener('load', () => {
              debug('original "onload"')

              this.status = originalRequest.status
              this.statusText = originalRequest.statusText
              this.responseURL = originalRequest.responseURL
              this.responseType = originalRequest.responseType
              this.response = originalRequest.response
              this.responseText = originalRequest.responseText
              this.responseXML = originalRequest.responseXML

              debug('set mock request readyState to DONE')

              // Explicitly mark the mocked request instance as done
              // so the response never hangs.
              /**
               * @note `readystatechange` listener is called TWICE
               * in the case of unhandled request.
               */
              this.setReadyState(this.DONE)

              debug('received original response', this.status, this.statusText)
              debug('original response body:', this.response)

              const responseHeaders = originalRequest.getAllResponseHeaders()
              debug('original response headers', responseHeaders)

              this._responseHeaders = stringToHeaders(responseHeaders)
              debug(
                'original response headers (normalized)',
                this._responseHeaders
              )

              debug('original response finished')

              observer.emit('response', isoRequest, {
                status: originalRequest.status,
                statusText: originalRequest.statusText,
                headers: this._responseHeaders,
                body: originalRequest.response,
              })
            })

            // Assign callbacks and event listeners from the intercepted XHR instance
            // to the original XHR instance.
            this.propagateCallbacks(originalRequest)
            this.propagateListeners(originalRequest)
            this.propagateHeaders(originalRequest, this._requestHeaders)

            if (this.async) {
              originalRequest.timeout = this.timeout
            }

            debug('send', this.data)
            originalRequest.send(this.data)
          }
        }
      )
    }

    public abort() {
      debug('abort')

      if (this.readyState > this.UNSENT && this.readyState < this.DONE) {
        this.setReadyState(this.UNSENT)
        this.trigger('abort')
      }
    }

    dispatchEvent() {
      return false
    }

    public setRequestHeader(name: string, value: string) {
      debug('set request header "%s" to "%s"', name, value)
      this._requestHeaders.append(name, value)
    }

    public getResponseHeader(name: string): string | null {
      debug('get response header "%s"', name)

      if (this.readyState < this.HEADERS_RECEIVED) {
        debug(
          'cannot return a header: headers not received (state: %s)',
          this.readyState
        )
        return null
      }

      const headerValue = this._responseHeaders.get(name)

      debug(
        'resolved response header "%s" to "%s"',
        name,
        headerValue,
        this._responseHeaders
      )

      return headerValue
    }

    public getAllResponseHeaders(): string {
      debug('get all response headers')

      if (this.readyState < this.HEADERS_RECEIVED) {
        debug(
          'cannot return headers: headers not received (state: %s)',
          this.readyState
        )
        return ''
      }

      return headersToString(this._responseHeaders)
    }

    public addEventListener<
      K extends keyof InternalXMLHttpRequestEventTargetEventMap
    >(name: K, listener: XMLHttpRequestEventHandler) {
      debug('addEventListener', name, listener)
      this._events.push({
        name,
        listener,
      })
    }

    public removeEventListener<K extends keyof XMLHttpRequestEventMap>(
      name: K,
      listener: (event?: XMLHttpRequestEventMap[K]) => void
    ): void {
      debug('removeEventListener', name, listener)
      this._events = this._events.filter((storedEvent) => {
        return storedEvent.name !== name && storedEvent.listener !== listener
      })
    }

    public overrideMimeType() {}

    /**
     * Resolves the response based on the `responseType` value.
     */
    getResponseBody(body: string | undefined) {
      // Handle an improperly set "null" value of the mocked response body.
      const textBody = body ?? ''
      debug('coerced response body to', textBody)

      switch (this.responseType) {
        case 'json': {
          debug('resolving response body as JSON')
          return parseJson(textBody)
        }

        case 'blob': {
          const blobType =
            this.getResponseHeader('content-type') || 'text/plain'
          debug('resolving response body as Blob', { type: blobType })

          return new Blob([textBody], {
            type: blobType,
          })
        }

        case 'arraybuffer': {
          debug('resolving response body as ArrayBuffer')
          const arrayBuffer = bufferFrom(textBody)
          return arrayBuffer
        }

        default:
          return textBody
      }
    }

    /**
     * Propagates mock XMLHttpRequest instance callbacks
     * to the given XMLHttpRequest instance.
     */
    propagateCallbacks(request: XMLHttpRequest) {
      request.onabort = this.abort
      request.onerror = this.onerror
      request.ontimeout = this.ontimeout
      request.onload = this.onload
      request.onloadstart = this.onloadstart
      request.onloadend = this.onloadend
      request.onprogress = this.onprogress
      request.onreadystatechange = this.onreadystatechange
    }

    /**
     * Propagates the mock XMLHttpRequest instance listeners
     * to the given XMLHttpRequest instance.
     */
    propagateListeners(request: XMLHttpRequest) {
      debug(
        'propagating request listeners (%d) to the original request',
        this._events.length,
        this._events
      )

      this._events.forEach(({ name, listener }) => {
        request.addEventListener(name, listener)
      })
    }

    propagateHeaders(request: XMLHttpRequest, headers: Headers) {
      debug('propagating request headers to the original request', headers)

      // Preserve the request headers casing.
      Object.entries(headers.raw()).forEach(([name, value]) => {
        debug('setting "%s" (%s) header on the original request', name, value)
        request.setRequestHeader(name, value)
      })
    }
  }
}
