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

    // Context menu & attachments
    const addContextBtn = document.getElementById('add-context-btn');
    const contextMenu = document.getElementById('context-menu');
    const attachmentPreviewsDiv = document.getElementById('attachment-previews');
    const mentionDropdown = document.getElementById('mention-dropdown');
    let attachedImages = []; // Array of { path, name, preview }
    let mentionStartPos = -1;
    let mentionDropdownVisible = false;

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

    inputField.addEventListener('input', () => {
        autoResize();
        handleMentionInput();
    });

    // ---- Context Menu (+ button) ----
    if (addContextBtn && contextMenu) {
        addContextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            contextMenu.classList.toggle('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target) && e.target !== addContextBtn) {
                contextMenu.classList.add('hidden');
            }
        });

        document.getElementById('ctx-media')?.addEventListener('click', () => {
            contextMenu.classList.add('hidden');
            vscode.postMessage({ type: 'pickImage' });
        });

        document.getElementById('ctx-mentions')?.addEventListener('click', () => {
            contextMenu.classList.add('hidden');
            inputField.value += '@';
            inputField.focus();
            handleMentionInput();
        });
    }

    // ---- Image Attachment Previews ----
    function renderAttachmentPreviews() {
        if (!attachmentPreviewsDiv) return;
        if (attachedImages.length === 0) {
            attachmentPreviewsDiv.classList.add('hidden');
            attachmentPreviewsDiv.innerHTML = '';
            return;
        }
        attachmentPreviewsDiv.classList.remove('hidden');
        attachmentPreviewsDiv.innerHTML = attachedImages.map((img, i) => {
            const preview = img.preview
                ? `<img src="${img.preview}" alt="${img.name}" class="thumb-img">`
                : `<div class="thumb-placeholder"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></div>`;
            return `<div class="attachment-thumb">
                ${preview}
                <button class="thumb-remove" data-index="${i}">×</button>
            </div>`;
        }).join('');

        attachmentPreviewsDiv.querySelectorAll('.thumb-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                attachedImages.splice(parseInt(btn.dataset.index), 1);
                renderAttachmentPreviews();
            });
        });
    }

    // ---- Ctrl+V Paste Image ----
    inputField.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const blob = item.getAsFile();
                if (!blob) break;
                const reader = new FileReader();
                reader.onload = () => {
                    vscode.postMessage({ type: 'pasteImage', data: reader.result });
                };
                reader.readAsDataURL(blob);
                break;
            }
        }
    });

    // ---- @ Mention Autocomplete ----
    function handleMentionInput() {
        const text = inputField.value;
        const cursorPos = inputField.selectionStart;
        const textBeforeCursor = text.substring(0, cursorPos);
        const lastAtIndex = textBeforeCursor.lastIndexOf('@');

        if (lastAtIndex >= 0) {
            const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
            // Only trigger if no space after @ (still typing the query)
            if (!textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
                mentionStartPos = lastAtIndex;
                vscode.postMessage({ type: 'getWorkspaceFiles', query: textAfterAt });
                return;
            }
        }
        hideMentionDropdown();
    }

    function showMentionDropdown(files) {
        if (!mentionDropdown || files.length === 0) {
            hideMentionDropdown();
            return;
        }

        mentionDropdown.innerHTML = files.slice(0, 10).map(f =>
            `<div class="mention-item" data-relative="${f.relativePath}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                <div class="mention-file-info">
                    <span class="mention-filename">${f.name}</span>
                    <span class="mention-filepath">${f.relativePath}</span>
                </div>
            </div>`
        ).join('');

        mentionDropdown.classList.remove('hidden');
        mentionDropdownVisible = true;

        mentionDropdown.querySelectorAll('.mention-item').forEach(item => {
            item.addEventListener('click', () => {
                selectMention(item.dataset.relative);
            });
        });
    }

    function selectMention(relativePath) {
        const text = inputField.value;
        const beforeMention = text.substring(0, mentionStartPos);
        const afterCursor = text.substring(inputField.selectionStart);
        inputField.value = beforeMention + '@' + relativePath + ' ' + afterCursor;
        inputField.focus();
        const newCursorPos = (beforeMention + '@' + relativePath + ' ').length;
        inputField.setSelectionRange(newCursorPos, newCursorPos);
        hideMentionDropdown();
    }

    function hideMentionDropdown() {
        if (mentionDropdown) mentionDropdown.classList.add('hidden');
        mentionDropdownVisible = false;
    }

    // Close mention dropdown on Escape
    inputField.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && mentionDropdownVisible) {
            e.preventDefault();
            hideMentionDropdown();
        }
    });

    let currentAssistantMessageNode = null;
    let currentAssistantRawContent = '';
    let currentThinkingNode = null;
    let currentThinkingContent = '';
    let thinkingStartTime = null;

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

    function createThinkingDropdown() {
        thinkingStartTime = Date.now();
        currentThinkingContent = '';

        const wrapper = document.createElement('div');
        wrapper.className = 'message-wrapper assistant-message animate-in';

        const header = document.createElement('div');
        header.className = 'message-header';
        header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg> Gemini`;

        // Thinking dropdown
        const thinkingBlock = document.createElement('div');
        thinkingBlock.className = 'thinking-block thinking-active';

        const thinkingSummary = document.createElement('div');
        thinkingSummary.className = 'thinking-summary';
        thinkingSummary.innerHTML = `
            <svg class="thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
            <span class="thinking-label">Thinking...</span>
        `;
        thinkingSummary.addEventListener('click', () => {
            thinkingBlock.classList.toggle('thinking-open');
        });

        const thinkingBody = document.createElement('div');
        thinkingBody.className = 'thinking-body';

        const thinkingDiv = document.createElement('div');
        thinkingDiv.className = 'thinking-content';
        thinkingBody.appendChild(thinkingDiv);

        thinkingBlock.appendChild(thinkingSummary);
        thinkingBlock.appendChild(thinkingBody);

        // Message content container (for the actual response, added later)
        const msgContent = document.createElement('div');
        msgContent.className = 'message-content';
        msgContent.style.display = 'none';

        wrapper.appendChild(header);
        wrapper.appendChild(thinkingBlock);
        wrapper.appendChild(msgContent);

        messagesDiv.appendChild(wrapper);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;

        currentThinkingNode = { wrapper, thinkingBlock, thinkingSummary, thinkingDiv, msgContent };
        return currentThinkingNode;
    }

    function appendThinkingChunk(chunk) {
        if (!currentThinkingNode) {
            createThinkingDropdown();
        }
        currentThinkingContent += chunk;
        // Render as formatted text (each line as a paragraph)
        const lines = currentThinkingContent.split('\n').filter(l => l.trim());
        currentThinkingNode.thinkingDiv.innerHTML = lines.map(l => `<p>${l.trim()}</p>`).join('');
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function finalizeThinking(seconds, fullContent) {
        if (!currentThinkingNode) {
            createThinkingDropdown();
        }

        const elapsed = seconds || Math.round((Date.now() - (thinkingStartTime || Date.now())) / 1000);
        const label = elapsed > 0 ? `Thought for ${elapsed}s` : 'Thought briefly';

        // Collapse the thinking block and update the label
        currentThinkingNode.thinkingBlock.classList.remove('thinking-active');
        currentThinkingNode.thinkingSummary.querySelector('.thinking-label').textContent = label;

        if (fullContent) {
            // Filter noise and render as formatted text
            const lines = fullContent.split('\n').filter(l => l.trim());
            const html = lines.map(l => `<p>${l.trim()}</p>`).join('');
            currentThinkingNode.thinkingDiv.innerHTML = html;
            currentThinkingNode.stderrHtml = html;
        } else {
            currentThinkingNode.stderrHtml = currentThinkingNode.thinkingDiv.innerHTML || '';
        }

        // Show the message content div for the actual response
        currentThinkingNode.msgContent.style.display = '';
        currentAssistantMessageNode = currentThinkingNode.msgContent;
        currentAssistantRawContent = '';
    }

    function streamMessageDynamic(response) {
        if (!currentAssistantMessageNode) {
            addMessage('assistant', response || '');
        } else {
            currentAssistantRawContent = response || '';
            currentAssistantMessageNode.innerHTML = marked.parse(currentAssistantRawContent);
            currentAssistantMessageNode.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        }
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function streamReasoning(reasoning) {
        if (!currentThinkingNode) return;
        
        const sentences = reasoning
            .split(/(?<=\.)\s+(?=[A-Z])/)
            .filter(s => s.trim())
            .map(s => `- ${s.trim()}`)
            .join('\n');
            
        const reasoningHtml = marked.parse(sentences);
        const baseHtml = currentThinkingNode.stderrHtml || '';
        const separator = baseHtml.trim() ? '<hr>' : '';
        
        currentThinkingNode.thinkingDiv.innerHTML = baseHtml + separator + reasoningHtml;
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function addMessage(role, content, images, reasoning) {
        const wrapper = document.createElement('div');
        wrapper.className = `message-wrapper ${role}-message animate-in`;

        const header = document.createElement('div');
        header.className = 'message-header';
        
        if (role === 'user') {
            header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg> You`;
            // Reset thinking state when user sends a new message
            currentThinkingNode = null;
            currentThinkingContent = '';
            thinkingStartTime = null;
        } else {
            header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg> Gemini`;
        }

        wrapper.appendChild(header);

        // Render attached images for user messages
        if (role === 'user' && images && images.length > 0) {
            const imagesDiv = document.createElement('div');
            imagesDiv.className = 'message-images';
            images.forEach(img => {
                if (img.preview) {
                    const imgEl = document.createElement('img');
                    imgEl.src = img.preview;
                    imgEl.className = 'message-thumb';
                    imgEl.alt = img.name || 'attached image';
                    imagesDiv.appendChild(imgEl);
                }
            });
            wrapper.appendChild(imagesDiv);
        }

        if (role === 'assistant' && reasoning) {
            const historyThinkingBlock = document.createElement('div');
            historyThinkingBlock.className = 'thinking-block';

            const historyThinkingSummary = document.createElement('div');
            historyThinkingSummary.className = 'thinking-summary';
            // Determine an approximate time or just show "Agent Reasoning"
            const wordCount = reasoning.split(' ').length;
            const approxSeconds = Math.max(1, Math.round(wordCount / 5)); // Roughly 5 words per second
            historyThinkingSummary.innerHTML = `
                <svg class="thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
                <span class="thinking-label">Thought for ~${approxSeconds}s</span>
            `;
            historyThinkingSummary.addEventListener('click', () => {
                historyThinkingBlock.classList.toggle('thinking-open');
            });

            const historyThinkingBody = document.createElement('div');
            historyThinkingBody.className = 'thinking-body';

            const historyThinkingDiv = document.createElement('div');
            historyThinkingDiv.className = 'thinking-content';
            
            const sentences = reasoning
                .split(/(?<=\.)\s+(?=[A-Z])/)
                .filter(s => s.trim())
                .map(s => `- ${s.trim()}`)
                .join('\n');
            historyThinkingDiv.innerHTML = marked.parse(sentences);

            historyThinkingBody.appendChild(historyThinkingDiv);
            historyThinkingBlock.appendChild(historyThinkingSummary);
            historyThinkingBlock.appendChild(historyThinkingBody);
            
            wrapper.appendChild(historyThinkingBlock);
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
        
        if (prompt || attachedImages.length > 0) {
            vscode.postMessage({
                type: 'sendPrompt',
                value: prompt,
                model: model,
                images: attachedImages.map(a => a.path),
                imagePreviews: attachedImages.map(a => ({ name: a.name, preview: a.preview }))
            });
            inputField.value = '';
            attachedImages = [];
            renderAttachmentPreviews();
            hideMentionDropdown();
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
                addMessage(message.role, message.content, message.images);
                break;
            case 'loadHistory':
                messagesDiv.innerHTML = '';
                currentAssistantMessageNode = null;
                currentAssistantRawContent = '';
                currentThinkingNode = null;
                currentThinkingContent = '';
                message.value.forEach(msg => {
                    addMessage(msg.role, msg.content, msg.images, msg.reasoning);
                });
                break;
            case 'sessionsList':
                renderHistory(message.value);
                break;
            case 'streamThinking':
                appendThinkingChunk(message.content);
                break;
            case 'thinkingDone':
                finalizeThinking(message.seconds, message.content);
                break;
            case 'streamMessage':
                appendToLastMessage(message.content);
                break;
            case 'streamReasoning':
                streamReasoning(message.reasoning);
                break;
            case 'streamMessageDynamic':
                streamMessageDynamic(message.response);
                break;
            case 'fileChanges':
                renderFileChanges(message.files);
                break;
            case 'fileAction':
                renderFileAction(message.file, message.path, message.action);
                break;
            case 'fileChanges':
                renderFileChanges(message.files);
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
            case 'imagesSelected':
                if (message.images) {
                    message.images.forEach(img => {
                        if (!attachedImages.find(a => a.path === img.path)) {
                            attachedImages.push(img);
                        }
                    });
                    renderAttachmentPreviews();
                }
                break;
            case 'workspaceFiles':
                showMentionDropdown(message.files || []);
                break;
        }
    });

    function renderFileChanges(files) {
        if (!files || files.length === 0) return;
        
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'file-chips-container animate-in';
        
        files.forEach(file => {
            const ext = (file.ext || '').toUpperCase();
            const action = (file.insertions === 0 && file.deletions > 0) ? 'Deleted' : 
                          (file.insertions > 0 && file.deletions === 0 && !file.name.includes('.')) ? 'Created' : 'Edited';
            
            const chip = document.createElement('div');
            chip.className = 'file-chip';
            chip.title = file.fullPath;
            chip.addEventListener('click', () => {
                vscode.postMessage({ type: 'openFile', value: file.fullPath });
            });
            
            chip.innerHTML = `
                <svg class="chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                <span class="chip-action">${action}</span>
                <span class="chip-lang">${ext}</span>
                <span class="chip-name">${file.name}</span>
                <span class="chip-diff diff-add">+${file.insertions}</span>
                <span class="chip-diff diff-del">-${file.deletions}</span>
                <svg class="chip-open-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            `;
            
            chipsContainer.appendChild(chip);
        });
        
        // Append right below the last message
        messagesDiv.appendChild(chipsContainer);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

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
            
            // Text container
            const textContent = document.createElement('div');
            textContent.style.flex = "1";
            textContent.style.minWidth = "0"; // enable text truncation
            textContent.innerHTML = `
                <div class="history-title">${session.title || 'Untitled Conversation'}</div>
                <div class="history-meta">${date}</div>
            `;

            // Delete button
            const deleteBtn = document.createElement('div');
            deleteBtn.className = 'history-delete-btn';
            deleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
            
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // prevent loading the session
                vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
                // Optimistically remove from UI
                item.remove();
            });

            item.appendChild(textContent);
            item.appendChild(deleteBtn);

            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'loadSession', sessionId: session.id });
                showView('chat-view');
            });

            historyList.appendChild(item);
        });
    }

    // Fetch auth status at launch
    vscode.postMessage({ type: 'getAuthState' });

    // ---- File Change Chips (Antigravity-style) ----
    function getLangTag(ext) {
        const map = {
            'ts': 'TS', 'tsx': 'TSX', 'js': 'JS', 'jsx': 'JSX',
            'css': 'CSS', 'scss': 'SCSS', 'less': 'LESS',
            'html': 'HTML', 'json': 'JSON', 'md': 'MD',
            'py': 'PY', 'rs': 'RS', 'go': 'GO',
            'yaml': 'YAML', 'yml': 'YAML', 'toml': 'TOML',
            'sh': 'SH', 'bash': 'SH', 'sql': 'SQL',
            'xml': 'XML', 'svg': 'SVG', 'vue': 'VUE',
        };
        return map[ext] || (ext ? ext.toUpperCase() : '');
    }

    function renderFileChanges(files) {
        if (!files || files.length === 0) return;

        const section = document.createElement('div');
        section.className = 'file-changes-section animate-in';

        // Summary header
        const header = document.createElement('div');
        header.className = 'file-changes-header';
        const totalAdd = files.reduce((s, f) => s + f.insertions, 0);
        const totalDel = files.reduce((s, f) => s + f.deletions, 0);
        header.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
            <span>${files.length} file${files.length > 1 ? 's' : ''} changed</span>
            <span class="fc-stats-summary"><span class="fc-add">+${totalAdd}</span> <span class="fc-del">-${totalDel}</span></span>
        `;
        section.appendChild(header);

        // File chips
        files.forEach(f => {
            const chip = document.createElement('div');
            chip.className = 'file-change-chip';

            const lang = getLangTag(f.ext);
            const langBadge = lang ? `<span class="fc-lang">${lang}</span>` : '';

            chip.innerHTML = `
                <svg class="fc-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                <span class="fc-action">Edited</span>
                ${langBadge}
                <span class="fc-name">${f.name}</span>
                <span class="fc-stats">
                    <span class="fc-add">+${f.insertions}</span>
                    <span class="fc-del">-${f.deletions}</span>
                </span>
                <svg class="fc-open" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            `;

            chip.addEventListener('click', () => {
                vscode.postMessage({ type: 'openFile', value: f.fullPath });
            });

            section.appendChild(chip);
        });

        messagesDiv.appendChild(section);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
})();
