import React from 'react'
import WorkspaceKanbanAreaSelectionOverlay from './WorkspaceKanbanAreaSelectionOverlay'
import WorkspaceKanbanDrawerHeader from './WorkspaceKanbanDrawerHeader'
import WorkspaceKanbanLaneGrid from './WorkspaceKanbanLaneGrid'
import WorkspaceKanbanPinDropTarget from './WorkspaceKanbanPinDropTarget'
import WorkspaceKanbanSheet from './WorkspaceKanbanSheet'
import { ActiveAgentTeam } from '../agent-group/ActiveAgentTeam'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type WorkspaceKanbanDrawerViewProps = {
  areaSelectionOverlayRef: React.RefObject<HTMLDivElement | null>
  boardRef: React.RefObject<HTMLDivElement | null>
  dragPreview: boolean
  headerProps: React.ComponentProps<typeof WorkspaceKanbanDrawerHeader>
  laneGridProps: React.ComponentProps<typeof WorkspaceKanbanLaneGrid>
  leftSidebarStyle?: React.CSSProperties
  onAreaSelectionPointerDown: React.PointerEventHandler<HTMLDivElement>
  onCardPointerDownCapture: React.PointerEventHandler<HTMLDivElement>
  onOpenChange: (open: boolean) => void
  onPinDragLeave: (event: React.DragEvent) => void
  onPinDragOver: (event: React.DragEvent) => void
  open: boolean
  pinDragOver: boolean
  preserveOpenForMenu: boolean
  sidebarOpen: boolean
  sidebarWidth: number
  statusBarVisible: boolean
}

export default function WorkspaceKanbanDrawerView(
  props: WorkspaceKanbanDrawerViewProps
): React.JSX.Element {
  const [team, setTeam] = React.useState(false)
  return (
    <WorkspaceKanbanSheet
      boardRef={props.boardRef}
      dragPreview={props.dragPreview}
      leftSidebarStyle={props.leftSidebarStyle}
      onOpenChange={props.onOpenChange}
      open={props.open}
      preserveOpenForMenu={props.preserveOpenForMenu}
      sidebarOpen={props.sidebarOpen}
      sidebarWidth={props.sidebarWidth}
      statusBarVisible={props.statusBarVisible}
    >
      <WorkspaceKanbanDrawerHeader {...props.headerProps} />
      <div className="flex gap-2 px-3 py-2">
        <Button size="sm" variant={team ? 'outline' : 'default'} onClick={() => setTeam(false)}>
          {translate('agentTeam.workspaces', 'Workspaces')}
        </Button>
        <Button size="sm" variant={team ? 'default' : 'outline'} onClick={() => setTeam(true)}>
          {translate('agentTeam.tasks', 'Active team tasks')}
        </Button>
      </div>
      {team ? (
        <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek p-3">
          <ActiveAgentTeam board />
        </div>
      ) : (
        <div
          ref={props.boardRef}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-3"
          data-workspace-board-selection-surface=""
          onPointerDownCapture={props.onCardPointerDownCapture}
          onPointerDown={props.onAreaSelectionPointerDown}
        >
          <WorkspaceKanbanAreaSelectionOverlay ref={props.areaSelectionOverlayRef} />
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2"
            data-contextual-tour-target="workspace-board-center"
          />
          <WorkspaceKanbanPinDropTarget
            isDragOver={props.pinDragOver}
            onDragOver={props.onPinDragOver}
            onDragLeave={props.onPinDragLeave}
          />
          <div
            ref={props.laneGridProps.laneScrollerRef}
            className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-sleek"
          >
            <WorkspaceKanbanLaneGrid {...props.laneGridProps} />
          </div>
        </div>
      )}
    </WorkspaceKanbanSheet>
  )
}
