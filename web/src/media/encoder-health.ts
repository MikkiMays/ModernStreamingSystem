/** Require sustained encoder pressure. Sparse frames on a static screen are not a failure. */
export class EncoderHealth {
  private overloaded = 0;
  observe(reason: string, advancedCodec: boolean) {
    this.overloaded = reason === 'cpu' && advancedCodec ? this.overloaded + 1 : 0;
    if (this.overloaded < 3) return false;
    this.overloaded = 0;
    return true;
  }
}
