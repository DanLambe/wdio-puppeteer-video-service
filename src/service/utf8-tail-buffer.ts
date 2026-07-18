import { StringDecoder } from 'node:string_decoder'

export class Utf8TailBuffer {
  private readonly decoder = new StringDecoder('utf8')
  private readonly maxLength: number
  private readonly parts: string[] = []
  private length = 0

  constructor(maxLength: number) {
    this.maxLength = maxLength
  }

  append(chunk: Buffer): void {
    this.appendText(this.decoder.write(chunk))
  }

  finish(): string {
    this.appendText(this.decoder.end())
    return this.parts.join('')
  }

  private appendText(text: string): void {
    if (text.length === 0) {
      return
    }

    this.parts.push(text)
    this.length += text.length

    while (this.length > this.maxLength) {
      const first = this.parts[0]
      if (first === undefined) {
        return
      }

      const excess = this.length - this.maxLength
      if (excess >= first.length) {
        this.parts.shift()
        this.length -= first.length
        continue
      }

      let sliceStart = excess
      const nextCodeUnit = first.charCodeAt(sliceStart)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        sliceStart += 1
      }

      this.parts[0] = first.slice(sliceStart)
      this.length -= sliceStart
    }
  }
}
