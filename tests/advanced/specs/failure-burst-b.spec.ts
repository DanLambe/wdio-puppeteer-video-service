import { runFailureBurst } from './failure-burst.js'

describe('Advanced E2E - Failure burst B', () => {
  it('should keep every part when worker B fails with the others', async () => {
    await runFailureBurst()
  })
})
