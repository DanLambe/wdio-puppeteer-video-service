
describe('Video Recording Verification', () => {
    it('should record a simple test', async () => {
        await browser.url('https://webdriver.io');
        await browser.pause(2000);
        const title = await browser.getTitle();
        console.log('Title:', title);
    });

    it('should handle multiple tabs', async () => {
        await browser.url('https://google.com');
        await browser.pause(1000);
        
        // Open new window
        await browser.newWindow('https://webdriver.io');
        await browser.pause(1000);

        // Switch back to google
        await browser.switchWindow('google.com');
        await browser.pause(1000);

        // Switch back to webdriverio
        await browser.switchWindow('webdriver.io');
        await browser.pause(1000);
    });

    it('should fail and save video (hypothetically, but we forced saveAllVideos=true)', async () => {
        await browser.url('https://example.com');
        await browser.pause(1000);
    });
});
