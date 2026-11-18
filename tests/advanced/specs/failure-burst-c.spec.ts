import { runFailureBurst } from './failure-burst.js'

describe('Advanced E2E - Failure burst C', () => {
  it('should keep every part when worker C fails with the others', async () => {
    await runFailureBurst()
  })
})
