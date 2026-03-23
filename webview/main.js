(function () {
    const vscode = acquireVsCodeApi();

    const messagesDiv = document.getElementById('messages');
    const inputField = document.getElementById('prompt-input');
    const sendButton = document.getElementById('send-button');
    const loadingDiv = document.getElementById('loading');
    
    const toggleSettingsBtn = document.getElementById('toggle-settings-btn');
    const chatView = document.getElementById('chat-view');
    const settingsView = document.getElementById('settings-view');
    const loginBtn = document.getElementById('login-btn');

    let inSettings = false;

    // Toggle Settings
    toggleSettingsBtn.addEventListener('click', () => {
        inSettings = !inSettings;
        if (inSettings) {
            chatView.classList.add('hidden');
            settingsView.classList.remove('hidden');
            toggleSettingsBtn.style.color = 'var(--vscode-foreground)';
            vscode.postMessage({ type: 'getAuthState' });
        } else {
            settingsView.classList.add('hidden');
            chatView.classList.remove('hidden');
            toggleSettingsBtn.style.color = '';
        }
    });

    // Login Action
    loginBtn.addEventListener('click', () => {
        // We'll jump back to chat to show the CLI output!
        toggleSettingsBtn.click();
        vscode.postMessage({ type: 'login' });
    });

    function autoResize() {
        inputField.style.height = 'auto';
        inputField.style.height = (inputField.scrollHeight) + 'px';
    }

    inputField.addEventListener('input', autoResize);

    function addMessage(role, content) {
        const wrapper = document.createElement('div');
        wrapper.className = `message-wrapper ${role}-message`;

        const header = document.createElement('div');
        header.className = 'message-header';
        
        if (role === 'user') {
            header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg> You`;
        } else {
            header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg> Gemini`;
        }

        const msgContent = document.createElement('div');
        msgContent.className = 'message-content';
        msgContent.textContent = content;

        wrapper.appendChild(header);
        wrapper.appendChild(msgContent);
        
        messagesDiv.appendChild(wrapper);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    sendButton.addEventListener('click', () => {
        const prompt = inputField.value.trim();
        const modelSelect = document.getElementById('model-select');
        const model = modelSelect ? modelSelect.value : 'auto';
        
        if (prompt) {
            vscode.postMessage({ type: 'sendPrompt', value: prompt, model: model });
            inputField.value = '';
            autoResize();
        }
    });

    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendButton.click();
        }
    });

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'addMessage':
                addMessage(message.role, message.content);
                break;
            case 'setLoading':
                if (message.value) {
                    loadingDiv.classList.remove('hidden');
                } else {
                    loadingDiv.classList.add('hidden');
                }
                break;
            case 'authState':
                const authInfo = document.getElementById('auth-info-text');
                if (authInfo) {
                    if (message.email) {
                        authInfo.innerHTML = `
<div class="user-profile">
    <div class="avatar-circle">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
    </div>
    <div class="user-info">
        <div class="user-label">Google Account</div>
        <div class="user-email">${message.email}</div>
        <div class="user-plan">Gemini Code Assist</div>
    </div>
</div>`;
                        loginBtn.textContent = 'Change Account';
                        loginBtn.className = 'secondary-button';
                    } else {
                        authInfo.innerHTML = 'Connect your Google Account to use the Gemini CLI natively through the workspace.';
                        loginBtn.textContent = 'Log In';
                        loginBtn.className = 'primary-button';
                    }
                }
                break;
        }
    });

    // Fetch auth status at launch
    vscode.postMessage({ type: 'getAuthState' });

    // In production we would restore previous state here.
    addMessage('assistant', "I am Gemini CLI, your autonomous software engineering assistant.\n\nLook around! I now support Antigravity's sleek UI aesthetic.");
}());
