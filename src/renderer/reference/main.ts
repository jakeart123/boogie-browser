// Floating reference window entry. Owned by ui-viewer.
import { mount } from 'svelte';
import '../styles/tokens.css';
import '../styles/base.css';
import ReferenceWindow from './ReferenceWindow.svelte';

mount(ReferenceWindow, { target: document.getElementById('app')! });
