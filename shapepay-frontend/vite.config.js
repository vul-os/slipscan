import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});

// screen -dmS scraper -L -Logfile scraper_log.txt go run main.go
//  tail -f scraper_log.txt
// screen -ls | grep Detached | cut -d. -f1 | awk '{print $1}' | xargs -I % screen -S % -X quit
