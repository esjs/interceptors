import { expect } from 'chai'
import { Headers } from 'headers-utils'
import { createInterceptor } from 'node-request-interceptor'
import { interceptXMLHttpRequest } from 'node-request-interceptor/lib/interceptors/XMLHttpRequest'

const interceptor = createInterceptor({
  modules: [interceptXMLHttpRequest],
  resolver(request, ref) {
    // Assert isomorphic request.
    expect(request.method).to.equal(expected.method)
    expect(request.url).to.be.instanceOf(URL)
    expect(request.url.toString()).to.equal(expected.url)
    Object.entries(expected.query || {}).forEach(([name, value]) => {
      expect(request.url.searchParams.get(name)).to.equal(value)
    })
    expect(request.headers).to.be.instanceOf(Headers)
    Object.entries(expected.headers || {}).forEach(([name, value]) => {
      expect(request.headers.get(name)).to.equal(value)
    })
    expect(request.body).to.equal(expected.body)

    // Assert request reference.
    expect(ref).to.be.instanceOf(XMLHttpRequest)
    expect(ref.method).to.equal(expected.method)
    expect(ref.url).to.equal(expected.url)
  },
})

interceptor.apply()
