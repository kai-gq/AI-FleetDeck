import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DOCKER_RESTART_POLICIES,
  DOCKER_PULL_POLICIES,
  type Building,
  type DockerRestartPolicy,
  type DockerPullPolicy,
  type ExistingDockerContainer,
} from '../../../shared/types';
import { store } from '../../store';
import { HelpTooltip } from '../shared/Tooltip';
import { FolderInput } from '../shared/FolderInput';
import { formatBytes } from './utils';

interface DockerConfigPanelProps {
  dockerMode: 'container' | 'compose' | 'existing';
  setDockerMode: (v: 'container' | 'compose' | 'existing') => void;
  dockerImage: string;
  setDockerImage: (v: string) => void;
  dockerContainerName: string;
  setDockerContainerName: (v: string) => void;
  dockerCommand: string;
  setDockerCommand: (v: string) => void;
  dockerPorts: string[];
  setDockerPorts: (v: string[]) => void;
  dockerVolumes: string[];
  setDockerVolumes: (v: string[]) => void;
  dockerNetwork: string;
  setDockerNetwork: (v: string) => void;
  dockerRestart: DockerRestartPolicy;
  setDockerRestart: (v: DockerRestartPolicy) => void;
  dockerPull: DockerPullPolicy;
  setDockerPull: (v: DockerPullPolicy) => void;
  dockerEnv: string;
  setDockerEnv: (v: string) => void;
  dockerComposePath: string;
  setDockerComposePath: (v: string) => void;
  dockerComposeProject: string;
  setDockerComposeProject: (v: string) => void;
  dockerComposeServices: string;
  setDockerComposeServices: (v: string) => void;
  selectedExistingContainer: string;
  setSelectedExistingContainer: (v: string) => void;
  dockerContainersList: ExistingDockerContainer[];
  isEditMode: boolean;
  building: Building | null;
  handleCommand: (cmd: 'start' | 'stop' | 'restart' | 'healthCheck' | 'logs') => void;
}

export function DockerConfigPanel({
  dockerMode,
  setDockerMode,
  dockerImage,
  setDockerImage,
  dockerContainerName,
  setDockerContainerName,
  dockerCommand,
  setDockerCommand,
  dockerPorts,
  setDockerPorts,
  dockerVolumes,
  setDockerVolumes,
  dockerNetwork,
  setDockerNetwork,
  dockerRestart,
  setDockerRestart,
  dockerPull,
  setDockerPull,
  dockerEnv,
  setDockerEnv,
  dockerComposePath,
  setDockerComposePath,
  dockerComposeProject,
  setDockerComposeProject,
  dockerComposeServices,
  setDockerComposeServices,
  selectedExistingContainer,
  setSelectedExistingContainer,
  dockerContainersList,
  isEditMode,
  building,
  handleCommand,
}: DockerConfigPanelProps) {
  const { t } = useTranslation(['config', 'common']);
  return (
    <div className="form-section docker-config-section">
      <label className="form-label">{t('config:buildings.dockerConfig')}</label>

      {/* Mode selector */}
      <div className="docker-mode-selector">
        <label className={`docker-mode-option ${dockerMode === 'container' ? 'active' : ''}`}>
          <input
            type="radio"
            name="dockerMode"
            value="container"
            checked={dockerMode === 'container'}
            onChange={() => setDockerMode('container')}
          />
          <span className="docker-mode-icon">&#128230;</span>
          <span className="docker-mode-label">{t('config:buildings.docker.modeContainer', { defaultValue: 'Container' })}</span>
          <span className="docker-mode-desc">{t('config:buildings.docker.modeContainerDesc', { defaultValue: 'Create a new container' })}</span>
        </label>
        <label className={`docker-mode-option ${dockerMode === 'compose' ? 'active' : ''}`}>
          <input
            type="radio"
            name="dockerMode"
            value="compose"
            checked={dockerMode === 'compose'}
            onChange={() => setDockerMode('compose')}
          />
          <span className="docker-mode-icon">&#128736;</span>
          <span className="docker-mode-label">{t('config:buildings.docker.modeCompose', { defaultValue: 'Compose' })}</span>
          <span className="docker-mode-desc">{t('config:buildings.docker.modeComposeDesc', { defaultValue: 'Manage multiple services' })}</span>
        </label>
        <label className={`docker-mode-option ${dockerMode === 'existing' ? 'active' : ''}`}>
          <input
            type="radio"
            name="dockerMode"
            value="existing"
            checked={dockerMode === 'existing'}
            onChange={() => setDockerMode('existing')}
          />
          <span className="docker-mode-icon">&#128270;</span>
          <span className="docker-mode-label">{t('config:buildings.docker.modeExisting', { defaultValue: 'Existing' })}</span>
          <span className="docker-mode-desc">{t('config:buildings.docker.modeExistingDesc', { defaultValue: 'Adopt existing container' })}</span>
        </label>
      </div>

      {/* Container Mode Fields */}
      {dockerMode === 'container' && (
        <>
          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.imageLabel', { defaultValue: 'Image:' })}
              <HelpTooltip
                text={t('config:buildings.docker.imageTooltip', { defaultValue: 'Docker image to run, e.g., nginx:latest, redis:alpine, my-app:v1' })}
                title={t('config:buildings.docker.imageTooltipTitle', { defaultValue: 'Image' })}
                position="top"
                size="sm"
              />
            </span>
            <input
              type="text"
              className="form-input"
              value={dockerImage}
              onChange={(e) => setDockerImage(e.target.value)}
              placeholder="nginx:latest"
              required
            />
          </div>

          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.containerNameLabel', { defaultValue: 'Container Name:' })}
              <HelpTooltip
                text={t('config:buildings.docker.containerNameTooltip', { defaultValue: 'Custom name for the container. If empty, auto-generated based on building name.' })}
                title={t('config:buildings.docker.containerNameTooltipTitle', { defaultValue: 'Container Name' })}
                position="top"
                size="sm"
              />
            </span>
            <input
              type="text"
              className="form-input"
              value={dockerContainerName}
              onChange={(e) => setDockerContainerName(e.target.value)}
              placeholder={t('config:buildings.docker.containerNamePlaceholder', { defaultValue: 'Auto-generated (tc-{name}-{id})' })}
            />
          </div>

          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.commandLabel', { defaultValue: 'Command:' })}
              <HelpTooltip
                text={t('config:buildings.docker.commandTooltip', { defaultValue: "Override the default container command. Leave empty to use image's CMD." })}
                title={t('config:buildings.docker.commandTooltipTitle', { defaultValue: 'Command Override' })}
                position="top"
                size="sm"
              />
            </span>
            <input
              type="text"
              className="form-input"
              value={dockerCommand}
              onChange={(e) => setDockerCommand(e.target.value)}
              placeholder={t('config:buildings.docker.commandPlaceholder', { defaultValue: 'Optional command override' })}
            />
          </div>

          {/* Ports */}
          <div className="form-section docker-ports-section">
            <label className="form-label">
              {t('config:buildings.docker.portMappingsLabel', { defaultValue: 'Port Mappings' })}
              <button
                type="button"
                className="btn btn-sm btn-add"
                onClick={() => setDockerPorts([...dockerPorts, ''])}
              >
                + {t('common:buttons.add')}
              </button>
            </label>
            {dockerPorts.map((port, index) => (
              <div key={index} className="docker-mapping-row">
                <input
                  type="text"
                  className="form-input"
                  value={port}
                  onChange={(e) => {
                    const newPorts = [...dockerPorts];
                    newPorts[index] = e.target.value;
                    setDockerPorts(newPorts);
                  }}
                  placeholder={t('config:buildings.docker.portPlaceholder', { defaultValue: '8080:80 or 3000' })}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setDockerPorts(dockerPorts.filter((_, i) => i !== index))}
                >
                  x
                </button>
              </div>
            ))}
            {dockerPorts.length === 0 && (
              <div className="form-hint">
                {t('config:buildings.docker.portHint', { defaultValue: 'Format: host:container (e.g., 8080:80) or same port (e.g., 3000)' })}
              </div>
            )}
          </div>

          {/* Volumes */}
          <div className="form-section docker-volumes-section">
            <label className="form-label">
              {t('config:buildings.docker.volumeMountsLabel', { defaultValue: 'Volume Mounts' })}
              <button
                type="button"
                className="btn btn-sm btn-add"
                onClick={() => setDockerVolumes([...dockerVolumes, ''])}
              >
                + {t('common:buttons.add')}
              </button>
            </label>
            {dockerVolumes.map((volume, index) => (
              <div key={index} className="docker-mapping-row">
                <input
                  type="text"
                  className="form-input"
                  value={volume}
                  onChange={(e) => {
                    const newVolumes = [...dockerVolumes];
                    newVolumes[index] = e.target.value;
                    setDockerVolumes(newVolumes);
                  }}
                  placeholder={t('config:buildings.docker.volumePlaceholder', { defaultValue: './data:/app/data or /host/path:/container/path' })}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setDockerVolumes(dockerVolumes.filter((_, i) => i !== index))}
                >
                  x
                </button>
              </div>
            ))}
            {dockerVolumes.length === 0 && (
              <div className="form-hint">
                {t('config:buildings.docker.volumeHint', { defaultValue: 'Format: host_path:container_path (relative paths resolved from working directory)' })}
              </div>
            )}
          </div>

          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.networkLabel', { defaultValue: 'Network:' })}
              <HelpTooltip
                text={t('config:buildings.docker.networkTooltip', { defaultValue: 'Docker network to connect to. Leave empty for default bridge network.' })}
                title={t('config:buildings.docker.networkTooltipTitle', { defaultValue: 'Network' })}
                position="top"
                size="sm"
              />
            </span>
            <input
              type="text"
              className="form-input"
              value={dockerNetwork}
              onChange={(e) => setDockerNetwork(e.target.value)}
              placeholder={t('config:buildings.docker.networkPlaceholder', { defaultValue: 'bridge (default)' })}
            />
          </div>

          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.restartPolicyLabel', { defaultValue: 'Restart Policy:' })}
              <HelpTooltip
                text={t('config:buildings.docker.restartPolicyTooltip', { defaultValue: 'When should Docker restart the container automatically?' })}
                title={t('config:buildings.docker.restartPolicyTooltipTitle', { defaultValue: 'Restart Policy' })}
                position="top"
                size="sm"
              />
            </span>
            <select
              className="form-input form-select"
              value={dockerRestart}
              onChange={(e) => setDockerRestart(e.target.value as DockerRestartPolicy)}
            >
              {(Object.keys(DOCKER_RESTART_POLICIES) as DockerRestartPolicy[]).map((policy) => (
                <option key={policy} value={policy}>
                  {t(`config:buildings.docker.restartPolicy.${policy}`, { defaultValue: DOCKER_RESTART_POLICIES[policy].label })}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {/* Compose Mode Fields */}
      {dockerMode === 'compose' && (
        <>
          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.composeFileLabel', { defaultValue: 'Compose File:' })}
              <HelpTooltip
                text={t('config:buildings.docker.composeFileTooltip', { defaultValue: 'Path to docker-compose.yml file, relative to working directory.' })}
                title={t('config:buildings.docker.composeFileTooltipTitle', { defaultValue: 'Compose File' })}
                position="top"
                size="sm"
              />
            </span>
            <FolderInput
              value={dockerComposePath}
              onChange={setDockerComposePath}
              placeholder="docker-compose.yml"
              className="form-input"
              directoriesOnly={false}
            />
          </div>

          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.projectNameLabel', { defaultValue: 'Project Name:' })}
              <HelpTooltip
                text={t('config:buildings.docker.projectNameTooltip', { defaultValue: 'Override the compose project name. Leave empty for auto-generated name.' })}
                title={t('config:buildings.docker.projectNameTooltipTitle', { defaultValue: 'Project Name' })}
                position="top"
                size="sm"
              />
            </span>
            <input
              type="text"
              className="form-input"
              value={dockerComposeProject}
              onChange={(e) => setDockerComposeProject(e.target.value)}
              placeholder={t('config:buildings.docker.projectNamePlaceholder', { defaultValue: 'Auto-generated' })}
            />
          </div>

          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.servicesLabel', { defaultValue: 'Services:' })}
              <HelpTooltip
                text={t('config:buildings.docker.servicesTooltip', { defaultValue: 'Specific services to manage (comma-separated). Leave empty for all services.' })}
                title={t('config:buildings.docker.servicesTooltipTitle', { defaultValue: 'Services' })}
                position="top"
                size="sm"
              />
            </span>
            <input
              type="text"
              className="form-input"
              value={dockerComposeServices}
              onChange={(e) => setDockerComposeServices(e.target.value)}
              placeholder={t('config:buildings.docker.servicesPlaceholder', { defaultValue: 'All services (or: api, db, redis)' })}
            />
          </div>
        </>
      )}

      {/* Existing Mode Fields */}
      {dockerMode === 'existing' && (
        <div className="docker-existing-section">
          <div className="command-row">
            <span className="command-label">
              {t('config:buildings.docker.selectContainerLabel', { defaultValue: 'Select Container:' })}
              <HelpTooltip
                text={t('config:buildings.docker.selectContainerTooltip', { defaultValue: 'Choose an existing Docker container to monitor and control. The container will not be deleted when removing the building.' })}
                title={t('config:buildings.docker.selectContainerTooltipTitle', { defaultValue: 'Existing Container' })}
                position="top"
                size="sm"
              />
            </span>
            <div className="docker-existing-select-wrapper">
              <select
                className="form-input form-select"
                value={selectedExistingContainer}
                onChange={(e) => setSelectedExistingContainer(e.target.value)}
                required={dockerMode === 'existing'}
              >
                <option value="">{t('config:buildings.docker.selectContainerPlaceholder', { defaultValue: 'Select a container...' })}</option>
                {dockerContainersList.map((container: ExistingDockerContainer) => (
                  <option key={container.id} value={container.name}>
                    {container.name} ({container.image}) - {container.state}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => store.requestDockerContainersList()}
                title={t('config:buildings.docker.refreshContainerListTitle', { defaultValue: 'Refresh container list' })}
              >
                &#8635;
              </button>
            </div>
          </div>
          {dockerContainersList.length === 0 && (
            <div className="form-hint docker-existing-hint">
              {t('config:buildings.docker.noContainersHint', { defaultValue: 'No containers found. Make sure Docker is running and you have containers available.' })}
            </div>
          )}
          {selectedExistingContainer && (
            <div className="docker-existing-info">
              {(() => {
                const container = dockerContainersList.find(c => c.name === selectedExistingContainer);
                if (!container) return null;
                return (
                  <>
                    <div className="docker-existing-info-row">
                      <span className="docker-existing-info-label">{t('config:buildings.docker.imageLabel', { defaultValue: 'Image:' })}</span>
                      <span className="docker-existing-info-value">{container.image}</span>
                    </div>
                    <div className="docker-existing-info-row">
                      <span className="docker-existing-info-label">{t('config:buildings.docker.existingInfoStatus', { defaultValue: 'Status:' })}</span>
                      <span className={`docker-existing-info-value docker-status-${container.status}`}>
                        {container.state}
                      </span>
                    </div>
                    <div className="docker-existing-info-row">
                      <span className="docker-existing-info-label">{t('config:buildings.docker.existingInfoId', { defaultValue: 'ID:' })}</span>
                      <span className="docker-existing-info-value">{container.id.slice(0, 12)}</span>
                    </div>
                    {container.ports.length > 0 && (
                      <div className="docker-existing-info-row">
                        <span className="docker-existing-info-label">{t('config:buildings.docker.existingInfoPorts', { defaultValue: 'Ports:' })}</span>
                        <span className="docker-existing-info-value">
                          {container.ports.map(p => `${p.host}:${p.container}/${p.protocol}`).join(', ')}
                        </span>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
          <div className="form-hint">
            {t('config:buildings.docker.existingNote', { defaultValue: 'Note: Existing containers will not be deleted when you remove this building.' })}
          </div>
        </div>
      )}

      {/* Common Options */}
      {dockerMode !== 'existing' && (
      <>
      <div className="command-row">
        <span className="command-label">
          {t('config:buildings.docker.pullPolicyLabel', { defaultValue: 'Pull Policy:' })}
          <HelpTooltip
            text={t('config:buildings.docker.pullPolicyTooltip', { defaultValue: 'When to pull images: always, only if missing, or never.' })}
            title={t('config:buildings.docker.pullPolicyTooltipTitle', { defaultValue: 'Pull Policy' })}
            position="top"
            size="sm"
          />
        </span>
        <select
          className="form-input form-select"
          value={dockerPull}
          onChange={(e) => setDockerPull(e.target.value as DockerPullPolicy)}
        >
          {(Object.keys(DOCKER_PULL_POLICIES) as DockerPullPolicy[]).map((policy) => (
            <option key={policy} value={policy}>
              {t(`config:buildings.docker.pullPolicy.${policy}`, { defaultValue: DOCKER_PULL_POLICIES[policy].label })}
            </option>
          ))}
        </select>
      </div>

      <div className="command-row env-row">
        <span className="command-label">
          {t('config:buildings.docker.environmentLabel', { defaultValue: 'Environment:' })}
          <HelpTooltip
            text={t('config:buildings.docker.environmentTooltip', { defaultValue: 'Environment variables in KEY=value format, one per line.' })}
            title={t('config:buildings.docker.environmentTooltipTitle', { defaultValue: 'Environment Variables' })}
            position="top"
            size="sm"
          />
        </span>
        <textarea
          className="form-input form-textarea"
          value={dockerEnv}
          onChange={(e) => setDockerEnv(e.target.value)}
          placeholder="KEY=value&#10;DATABASE_URL=postgres://...&#10;NODE_ENV=production"
          rows={3}
        />
      </div>
      </>
      )}

      {/* Docker Status Display */}
      {isEditMode && building?.dockerStatus && (
        <div className="docker-status-display">
          <div className="docker-status-row">
            <span className="docker-metric">
              <span className="docker-metric-label">{t('config:buildings.docker.metricId', { defaultValue: 'ID' })}</span>
              <span className="docker-metric-value">{building.dockerStatus.containerId || '-'}</span>
            </span>
            <span className="docker-metric">
              <span className="docker-metric-label">{t('config:buildings.docker.metricStatus', { defaultValue: 'Status' })}</span>
              <span className="docker-metric-value">{building.dockerStatus.status || '-'}</span>
            </span>
            {building.dockerStatus.health && building.dockerStatus.health !== 'none' && (
              <span className="docker-metric">
                <span className="docker-metric-label">{t('config:buildings.docker.metricHealth', { defaultValue: 'Health' })}</span>
                <span className="docker-metric-value">{building.dockerStatus.health}</span>
              </span>
            )}
            {building.dockerStatus.cpu !== undefined && (
              <span className="docker-metric">
                <span className="docker-metric-label">{t('config:buildings.docker.metricCpu', { defaultValue: 'CPU' })}</span>
                <span className="docker-metric-value">{building.dockerStatus.cpu.toFixed(1)}%</span>
              </span>
            )}
            {building.dockerStatus.memory !== undefined && (
              <span className="docker-metric">
                <span className="docker-metric-label">{t('config:buildings.docker.metricMem', { defaultValue: 'MEM' })}</span>
                <span className="docker-metric-value">
                  {formatBytes(building.dockerStatus.memory)}
                  {building.dockerStatus.memoryLimit ? ` / ${formatBytes(building.dockerStatus.memoryLimit)}` : ''}
                </span>
              </span>
            )}
          </div>
          {building.dockerStatus.ports && building.dockerStatus.ports.length > 0 && (
            <div className="docker-ports-row">
              <span className="docker-metric-label">{t('config:buildings.docker.existingInfoPorts', { defaultValue: 'Ports:' })}</span>
              {building.dockerStatus.ports.map((p, i) => (
                <a
                  key={i}
                  href={`http://${window.location.hostname}:${p.host}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="docker-port-link"
                >
                  {p.host}:{p.container}/{p.protocol}
                </a>
              ))}
            </div>
          )}
          {/* Compose services status */}
          {building.dockerStatus.services && building.dockerStatus.services.length > 0 && (
            <div className="docker-services-status">
              <span className="docker-metric-label">{t('config:buildings.docker.servicesLabel', { defaultValue: 'Services:' })}</span>
              <div className="docker-services-grid">
                {building.dockerStatus.services.map((svc, i) => (
                  <div key={i} className="docker-service-item">
                    <span
                      className="docker-service-indicator"
                      style={{ backgroundColor: svc.status === 'running' ? '#4ade80' : '#f87171' }}
                    />
                    <span className="docker-service-name">{svc.name}</span>
                    <span className="docker-service-status">{svc.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Docker Action Buttons */}
      {isEditMode && (
        <div className="docker-actions">
          <button
            type="button"
            className="btn btn-sm btn-success"
            onClick={() => handleCommand('start')}
          >
            {t('common:buttons.start')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => handleCommand('stop')}
          >
            {t('common:buttons.stop')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-warning"
            onClick={() => handleCommand('restart')}
          >
            {t('config:buildings.docker.actionRestart', { defaultValue: 'Restart' })}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => handleCommand('logs')}
          >
            {t('config:buildings.docker.actionLogs', { defaultValue: 'Logs' })}
          </button>
        </div>
      )}
    </div>
  );
}
