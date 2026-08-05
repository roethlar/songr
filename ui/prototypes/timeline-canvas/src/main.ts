import { mount } from 'svelte';
import App from './App.svelte';
import './prototype.css';

const target = document.querySelector<HTMLDivElement>('#app');

if (!target) {
	throw new Error('Timeline harness root is missing');
}

mount(App, { target });
