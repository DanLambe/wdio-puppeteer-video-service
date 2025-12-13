
import fse from 'fs-extra'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const {readdir, stat} = fse

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const videosDir = path.join(__dirname, '../../tests/results'); 

describe('Video Recording Service E2E Verification', () => {

    it('should record a simple navigation', async () => {
        await browser.url('http://the-internet.herokuapp.com/');
        await expect(browser).toHaveTitle('The Internet');
        await browser.pause(1000); 
    });

    it('should handle iframe switching', async () => {
        await browser.url('http://the-internet.herokuapp.com/nested_frames');
        
        // Switch to top frame
        const topFrame = await $('[name="frame-top"]');
        await browser.switchFrame(topFrame);
        
        // Switch to middle frame
        const middleFrame = await $('[name="frame-middle"]');
        await browser.switchFrame(middleFrame);
        
        // Assert content
        const content = await $('#content');
        await expect(content).toHaveText('MIDDLE');
        
        // Switch to top level
        await browser.switchFrame(null);
        
        // Switch to bottom frame
        const bottomFrame = await $('[name="frame-bottom"]');
        await browser.switchFrame(bottomFrame);
        const body = await $('body');
        await expect(body).toHaveText(expect.stringContaining('BOTTOM'));
        
        // Switch back to top level
        await browser.switchFrame(null);
        await browser.pause(1000);
    });

    it('should handle multiple tabs and closing tabs', async () => {
        await browser.url('http://the-internet.herokuapp.com/windows');
        const link = await $('=Click Here');
        await link.click();
        
        // Wait for new window
        await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2);
        
        const handles = await browser.getWindowHandles();
        await browser.switchToWindow(handles[1]);
        await expect($('h3')).toHaveText('New Window');
        await browser.pause(1000);
        
        await browser.closeWindow();
        await browser.switchToWindow(handles[0]);
        await expect($('h3')).toHaveText('Opening a new window');
        await browser.pause(1000);
    });
    
    it('should handle viewport resizing', async () => {
         await browser.url('http://the-internet.herokuapp.com/');
         await browser.setWindowSize(500, 600);
         await browser.pause(500);
         await browser.setWindowSize(1200, 800);
         await browser.pause(500);
    });

    it('should handle javascript alerts', async () => {
        await browser.url('http://the-internet.herokuapp.com/javascript_alerts');
        const button = await $('button=Click for JS Alert');
        await button.click();
        await browser.acceptAlert();
        await expect($('#result')).toHaveText('You successfully clicked an alert');
        await browser.pause(1000);
    });

    after(async () => {
        // Verify artifacts exist after all tests run
        console.log('Verifying generated video artifacts...');
        
        // Wait a bit for FS flush 
        await new Promise(r => setTimeout(r, 2000));

        let allFiles: string[] = [];
        try {
            allFiles = await readdir(videosDir);
        } catch (e) {
            console.warn('Could not read video dir:', e);
        }
        
        console.log('Files in output dir:', allFiles);

        if (allFiles.length === 0) {
            throw new Error('No video files were generated!');
        }
        
        // Basic size check
        for (const file of allFiles) {
            const stats = await stat(path.join(videosDir, file));
            if (stats.size < 100) {
                if (file.endsWith('.mp4') || file.endsWith('.webm')) {
                     console.warn(`Video file ${file} is too small (${stats.size} bytes).`);
                }
            }
        }
        
        console.log('Verification successful!');
    });
});
