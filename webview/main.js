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

    const historyView = document.getElementById('history-view');
    const historyList = document.getElementById('history-list');

    function showView(viewId) {
        [chatView, settingsView, historyView].forEach(v => v?.classList.add('hidden'));
        document.getElementById(viewId)?.classList.remove('hidden');
    }

    // Header Actions
    let yoloEnabled = false;
    const yoloBtn = document.getElementById('yolo-btn');

    yoloBtn.addEventListener('click', () => {
        yoloEnabled = !yoloEnabled;
        updateYoloUI();
        vscode.postMessage({ type: 'toggleYolo', value: yoloEnabled });
    });

    function updateYoloUI() {
        if (yoloEnabled) {
            yoloBtn.classList.add('active-yolo');
            yoloBtn.title = 'Autonomous Mode Enabled (YOLO)';
        } else {
            yoloBtn.classList.remove('active-yolo');
            yoloBtn.title = 'Autonomous Mode (YOLO)';
        }
    }

    toggleSettingsBtn.addEventListener('click', () => {
        if (settingsView.classList.contains('hidden')) {
            showView('settings-view');
            vscode.postMessage({ type: 'getAuthState' });
        } else {
            showView('chat-view');
        }
    });

    const newChatBtnHeader = document.getElementById('new-chat-btn-header');
    newChatBtnHeader.addEventListener('click', () => {
        messagesDiv.innerHTML = '';
        currentAssistantMessageNode = null;
        currentAssistantRawContent = '';
        vscode.postMessage({ type: 'newChat' });
        addMessage('assistant', "New chat started. How can I help you?");
        showView('chat-view');
    });

    const historyBtn = document.getElementById('history-btn');
    const closeHistoryBtn = document.getElementById('close-history-btn');

    historyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'getSessions' });
        showView('history-view');
    });

    if (closeHistoryBtn) {
        closeHistoryBtn.addEventListener('click', () => showView('chat-view'));
    }

    // Clear History Action (from Settings)
    const clearBtn = document.getElementById('clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the chat history for this project?')) {
                messagesDiv.innerHTML = '';
                vscode.postMessage({ type: 'clearHistory' });
                addMessage('assistant', "Chat history cleared. How can I help you today?");
            }
        });
    }

    // Login Action
    loginBtn.addEventListener('click', () => {
        showView('chat-view');
        vscode.postMessage({ type: 'login' });
    });

    function autoResize() {
        inputField.style.height = 'auto';
        inputField.style.height = (inputField.scrollHeight) + 'px';
    }

    inputField.addEventListener('input', autoResize);

    let currentAssistantMessageNode = null;
    let currentAssistantRawContent = '';

    // Configure marked with highlight.js
    marked.setOptions({
        highlight: function(code, lang) {
            const language = hljs.getLanguage(lang) ? lang : 'plaintext';
            return hljs.highlight(code, { language }).value;
        },
        langPrefix: 'hljs language-'
    });

    function renderFileAction(file, fullPath, action) {
        const actionDiv = document.createElement('div');
        actionDiv.className = 'file-action-chip';
        
        const icon = action === 'edit' ? 
            `<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>` : 
            `<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>`;

        actionDiv.innerHTML = `
            ${icon}
            <span class="action-text">${action === 'edit' ? 'Edited' : 'Created'}</span>
            <span class="file-name">${file}</span>
            <button class="diff-btn" onclick="openFileInIDE('${fullPath.replace(/\\/g, '\\\\')}')">DIFF</button>
        `;
        
        messagesDiv.appendChild(actionDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    window.openFileInIDE = (path) => {
        vscode.postMessage({ type: 'openFile', value: path });
    };

    function addMessage(role, content) {
        const wrapper = document.createElement('div');
        wrapper.className = `message-wrapper ${role}-message animate-in`;

        const header = document.createElement('div');
        header.className = 'message-header';
        
        if (role === 'user') {
            header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg> You`;
        } else {
            header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg> Gemini`;
        }

        const msgContent = document.createElement('div');
        msgContent.className = 'message-content';
        
        if (role === 'assistant') {
            currentAssistantMessageNode = msgContent;
            currentAssistantRawContent = content;
            msgContent.innerHTML = marked.parse(content);
        } else {
            currentAssistantMessageNode = null;
            msgContent.textContent = content;
        }

        wrapper.appendChild(header);
        wrapper.appendChild(msgContent);
        
        messagesDiv.appendChild(wrapper);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        
        // Apply syntax highlighting to any code blocks
        msgContent.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
        });
    }

    function appendToLastMessage(chunk) {
        if (!currentAssistantMessageNode) {
            addMessage('assistant', chunk);
        } else {
            currentAssistantRawContent += chunk;
            currentAssistantMessageNode.innerHTML = marked.parse(currentAssistantRawContent);
            
            // Apply syntax highlighting to any code blocks
            currentAssistantMessageNode.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
            
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
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
            case 'loadHistory':
                messagesDiv.innerHTML = '';
                currentAssistantMessageNode = null;
                currentAssistantRawContent = '';
                message.value.forEach(msg => {
                    addMessage(msg.role, msg.content);
                });
                break;
            case 'sessionsList':
                renderHistory(message.value);
                break;
            case 'streamMessage':
                appendToLastMessage(message.content);
                break;
            case 'fileAction':
                renderFileAction(message.file, message.path, message.action);
                break;
            case 'yoloState':
                yoloEnabled = message.value;
                updateYoloUI();
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

    function renderHistory(sessions) {
        historyList.innerHTML = '';
        const sortedSessions = Object.values(sessions).sort((a, b) => b.timestamp - a.timestamp);
        
        if (sortedSessions.length === 0) {
            historyList.innerHTML = '<div class="auth-placeholder" style="padding: 20px; text-align: center;">No past conversations found. Start a new one!</div>';
            return;
        }

        sortedSessions.forEach(session => {
            const item = document.createElement('div');
            item.className = 'history-item';
            const date = new Date(session.timestamp).toLocaleDateString() + ' ' + new Date(session.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            item.innerHTML = `
                <div class="history-title">${session.title || 'Untitled Conversation'}</div>
                <div class="history-meta">${date}</div>
            `;

            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'loadSession', sessionId: session.id });
                showView('chat-view');
            });

            historyList.appendChild(item);
        });
    }

    // Fetch auth status at launch
    vscode.postMessage({ type: 'getAuthState' });
})();
