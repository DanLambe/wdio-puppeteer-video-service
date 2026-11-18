import { runFailureBurst } from './failure-burst.js'

describe('Advanced E2E - Failure burst A', () => {
  it('should keep every part when worker A fails with the others', async () => {
    await runFailureBurst()
  })
})
